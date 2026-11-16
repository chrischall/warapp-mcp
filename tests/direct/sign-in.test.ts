import { McpToolError } from '@chrischall/mcp-utils';
import { MockAgent } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  createSignInFetch,
  parseSetCookie,
  SIGN_IN_URL,
  signIn,
  type SignInFetch,
  type SignInResponse,
} from '../../src/direct/sign-in.js';

// Synthetic values only — never a real war.app account, password or AuthToken (CLAUDE.md: no captures).
const EMAIL = 'test@example.com';
const PASSWORD = 'hunter2-Secret!';
const FAKE_TOKEN = 'fakeAuthToken123';
const JSES = 'jsesValue789';

const FORM_PAGE =
  '<html><body><form id="LoginForm" method="post"><input name="Email" type="email">' +
  '<input name="Password" type="password"><input type="checkbox" name="KeepSignedIn" checked></form></body></html>';
const HOME_PAGE = '<html><body>Welcome back</body></html>';

const page = (over: Partial<SignInResponse> = {}): SignInResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  setCookies: [],
  body: FORM_PAGE,
  ...over,
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A scripted single-hop fetch: answers each call with the next response, recording it. */
function scripted(...responses: SignInResponse[]): { fetch: SignInFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: SignInFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch, calls };
}

const getPage = () =>
  page({ setCookies: [`jses_WS60=${JSES}; Path=/; Secure; HttpOnly; SameSite=Lax`, 'FirstReferrer=x; Path=/', 'AWSELB=y; Path=/'] });

async function refusalOf(p: Promise<unknown>): Promise<McpToolError> {
  const err = await p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpToolError);
  return err as McpToolError;
}

function expectClean(err: McpToolError, ...values: string[]) {
  const text = `${err.message} ${err.hint ?? ''} ${String(err.stack)}`;
  for (const v of [EMAIL, PASSWORD, FAKE_TOKEN, JSES, ...values]) expect(text).not.toContain(v);
  expect(text.toLowerCase()).not.toContain(EMAIL.toLowerCase());
  expect(err.cause).toBeUndefined();
}

describe('signIn', () => {
  it('signs in through a redirect that sets AuthToken, carrying the page cookies to the POST', async () => {
    const { fetch, calls } = scripted(
      getPage(),
      page({ status: 302, headers: { location: '/MultiPlayer' }, setCookies: [`AuthToken=${FAKE_TOKEN}; Path=/; Secure; HttpOnly`], body: '' }),
    );
    const result = await signIn({ email: EMAIL, password: PASSWORD }, { fetch });
    expect(result).toEqual({ authToken: FAKE_TOKEN });
    expect(Object.keys(result)).toEqual(['authToken']);
    // GET the page, then ONE POST; the redirect after the AuthToken is not followed.
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', SIGN_IN_URL],
      ['POST', SIGN_IN_URL],
    ]);
    const post = calls[1]!;
    expect(post.headers.cookie).toBe(`jses_WS60=${JSES}; FirstReferrer=x; AWSELB=y`);
    expect(post.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({ Email: EMAIL, Password: PASSWORD, KeepSignedIn: 'on' });
    expect(calls[0]!.headers.cookie).toBeUndefined();
  });

  it('signs in when the AuthToken is set on a later redirect hop, following it as a GET without the password', async () => {
    const { fetch, calls } = scripted(
      getPage(),
      page({ status: 307, headers: { location: 'https://war.app/LogIn/Done' }, body: '' }),
      page({ status: 302, headers: { location: '/' }, setCookies: [`AuthToken=${FAKE_TOKEN}; Path=/`], body: '' }),
    );
    await expect(signIn({ email: EMAIL, password: PASSWORD }, { fetch })).resolves.toEqual({ authToken: FAKE_TOKEN });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[2]!.body).toBeUndefined();
    expect(calls[2]!.url).toBe('https://war.app/LogIn/Done');
  });

  it('signs in on the POST response itself', async () => {
    const { fetch, calls } = scripted(getPage(), page({ setCookies: [`AuthToken="${FAKE_TOKEN}"; Max-Age=31536000`], body: HOME_PAGE }));
    await expect(signIn({ email: ` ${EMAIL} `, password: PASSWORD }, { fetch })).resolves.toEqual({ authToken: FAKE_TOKEN });
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(calls[1]!.body).get('Email')).toBe(EMAIL);
  });

  it('follows a redirect on the sign-in page within war.app before the attempt', async () => {
    const { fetch, calls } = scripted(
      page({ status: 301, headers: { location: '/Login' }, setCookies: ['AWSELB=z'], body: '' }),
      getPage(),
      page({ setCookies: [`AuthToken=${FAKE_TOKEN}`], body: HOME_PAGE }),
    );
    await expect(signIn({ email: EMAIL, password: PASSWORD }, { fetch })).resolves.toEqual({ authToken: FAKE_TOKEN });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', SIGN_IN_URL],
      ['GET', 'https://war.app/Login'],
      ['POST', SIGN_IN_URL],
    ]);
    expect(calls[1]!.headers.cookie).toBe('AWSELB=z');
  });

  it('a wrong password (the form back) is credential_rejected, sent once and never retried', async () => {
    const { fetch, calls } = scripted(getPage(), page({ body: `${FORM_PAGE}<p>Invalid email or password for ${EMAIL}</p>` }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('credential_rejected');
    expect(err.message).toMatch(/email or password is not right/);
    expect(err.message).toMatch(/not retried/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expectClean(err);
  });

  it('a wrong password that redirects back to the sign-in page is credential_rejected too', async () => {
    const { fetch } = scripted(getPage(), page({ status: 303, headers: { location: '/LogIn?error=1' }, body: '' }), page());
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('credential_rejected');
  });

  it('a captcha after the POST is a challenge, not a wrong password', async () => {
    const { fetch } = scripted(
      getPage(),
      page({ body: `${FORM_PAGE}<div class="g-recaptcha" data-sitekey="k"></div>` }),
    );
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('edge_blocked');
    expect(err.message).toMatch(/captcha/);
    // No paste flow is built: the hint must not send the operator to one (#333 review).
    expect(err.hint).not.toMatch(/paste|auth-flow-paste/);
    expect(err.hint).toMatch(/Sign in/);
    expectClean(err);
  });

  it('a CDN challenge page on the sign-in page is refused before any password is sent', async () => {
    const { fetch, calls } = scripted(
      page({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>Just a moment...</html>' }),
    );
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('edge_blocked');
    expect(err.message).toMatch(/Cloudflare/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a 429 is a challenge', async () => {
    const { fetch } = scripted(getPage(), page({ status: 429, body: 'slow down' }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('edge_blocked');
    expect(err.message).toMatch(/429/);
  });

  it('a bare 403 after the POST is a challenge', async () => {
    const { fetch } = scripted(getPage(), page({ status: 403, body: 'Forbidden' }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('edge_blocked');
    expect(err.message).toMatch(/403/);
  });

  it('refuses a redirect off war.app without requesting it', async () => {
    for (const location of ['https://evil.example/steal', 'http://war.app/LogIn', 'https://war.app:8443/x', 'https://u:p@war.app/']) {
      const { fetch, calls } = scripted(getPage(), page({ status: 302, headers: { location }, body: '' }));
      const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
      expect(err.message, location).toMatch(/away from https:\/\/war\.app/);
      expect(calls.map((c) => c.url)).toEqual([SIGN_IN_URL, SIGN_IN_URL]);
    }
  });

  it('refuses a redirect off war.app on the sign-in page, so no password is ever sent', async () => {
    const { fetch, calls } = scripted(page({ status: 302, headers: { location: 'https://evil.example/LogIn' }, body: '' }));
    await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('stops after a few redirects', async () => {
    const loop = () => page({ status: 302, headers: { location: '/a' }, body: '' });
    const { fetch, calls } = scripted(getPage(), loop(), loop(), loop(), loop());
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.message).toMatch(/more than 3 times/);
    expect(calls).toHaveLength(5);
  });

  it('refuses a redirect whose address does not parse', async () => {
    const { fetch } = scripted(getPage(), page({ status: 302, headers: { location: 'http://[::1' }, body: '' }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.message).toMatch(/does not parse/);
  });

  it('a sign-in page without its form is refused before any password is sent', async () => {
    const { fetch, calls } = scripted(page({ status: 503, body: 'down for maintenance' }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('http');
    expect(err.message).toMatch(/no password was sent/);
    expect(calls).toHaveLength(1);
  });

  it('keeps following the sign-in page past a redirect that sets an AuthToken: only the POST may end a phase on it', async () => {
    const { fetch, calls } = scripted(
      page({ status: 302, headers: { location: '/LogIn?r=1' }, setCookies: ['AuthToken=staleFromPage'], body: '' }),
      getPage(),
      page({ setCookies: [`AuthToken=${FAKE_TOKEN}`], body: HOME_PAGE }),
    );
    await expect(signIn({ email: EMAIL, password: PASSWORD }, { fetch })).resolves.toEqual({ authToken: FAKE_TOKEN });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', SIGN_IN_URL],
      ['GET', 'https://war.app/LogIn?r=1'],
      ['POST', SIGN_IN_URL],
    ]);
  });

  it('ignores an AuthToken the sign-in page sets on its own: only one the POST earns counts', async () => {
    const { fetch } = scripted(page({ setCookies: ['AuthToken=stale'] }), page({ body: HOME_PAGE }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('unknown');
    expect(err.message).toMatch(/without setting a session/);
  });

  it('refuses an AuthToken the hosted child could not use, without echoing it', async () => {
    const odd = 'short;one';
    const { fetch } = scripted(getPage(), page({ setCookies: [`AuthToken="${odd}"`], body: HOME_PAGE }));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.message).toMatch(/not in a shape/);
    expect(err.message).not.toContain(odd);
  });

  it('an AuthToken deletion does not count as a session', async () => {
    const { fetch } = scripted(
      getPage(),
      page({ status: 500, setCookies: ['AuthToken=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], body: 'oops' }),
    );
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('http');
    expect(err.message).toMatch(/HTTP 500/);
  });

  it('refuses an empty email or password without a request', async () => {
    const fetch = vi.fn<SignInFetch>();
    expect((await refusalOf(signIn({ email: ' ', password: PASSWORD }, { fetch }))).kind).toBe('no_credential');
    expect((await refusalOf(signIn({ email: EMAIL, password: '' }, { fetch }))).kind).toBe('no_credential');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a network failure before the POST says nothing was sent; after it, that it was not retried', async () => {
    const boom = (n: number): SignInFetch => {
      let i = 0;
      return async () => {
        if (i++ === n) throw new Error(`connect ECONNREFUSED with ${EMAIL} ${PASSWORD} jses_WS60=${JSES}`);
        return getPage();
      };
    };
    const before = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch: boom(0) }));
    expect(before.kind).toBe('transport');
    expect(before.message).toMatch(/Nothing was sent/);
    const after = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch: boom(1) }));
    expect(after.kind).toBe('transport');
    expect(after.message).toMatch(/not retried/);
    expectClean(before);
    expectClean(after);
  });

  it('a deadline past is a timeout', async () => {
    const fetch: SignInFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch, timeoutMs: 5 }));
    expect(err.kind).toBe('timeout');
  });

  it("the caller's cancellation is its own reason", async () => {
    const ctl = new AbortController();
    const fetch: SignInFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
        ctl.abort(new Error('cancelled by caller'));
      });
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch, signal: ctl.signal }));
    expect(err.message).toBe('cancelled by caller');
  });

  it('scrubs the email (any case), the password and every cookie value from any refusal text', async () => {
    let n = 0;
    const fetch: SignInFetch = async () => {
      if (n++ === 0) return getPage();
      throw new McpToolError(`war.app echoed ${EMAIL.toUpperCase()} / ${encodeURIComponent(PASSWORD)} / ${JSES}`, {
        kind: 'too_large',
        hint: `cookie jses_WS60=${JSES}; password=${PASSWORD}`,
      });
    };
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('too_large');
    expect(err.message).toContain('war.app echoed');
    expectClean(err, encodeURIComponent(PASSWORD));
  });

  it('a non-McpToolError thrown on the way is scrubbed and reported as unknown', async () => {
    const fetch: SignInFetch = async () => {
      throw 'not an error';
    };
    // A thrown string still goes through the transport refusal (never echoed).
    const err = await refusalOf(signIn({ email: EMAIL, password: PASSWORD }, { fetch }));
    expect(err.kind).toBe('transport');
  });
});

describe('parseSetCookie', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  it('reads the name and value, unquoting', () => {
    expect(parseSetCookie('AuthToken=abc; Path=/; HttpOnly', now)).toEqual({ name: 'AuthToken', value: 'abc' });
    expect(parseSetCookie('AuthToken="abc"', now)).toEqual({ name: 'AuthToken', value: 'abc' });
  });
  it('reads a deletion as a null value', () => {
    expect(parseSetCookie('AuthToken=; Path=/', now)).toEqual({ name: 'AuthToken', value: null });
    expect(parseSetCookie('AuthToken=abc; Max-Age=0', now)).toEqual({ name: 'AuthToken', value: null });
    expect(parseSetCookie('AuthToken=abc; expires=Thu, 01 Jan 1970 00:00:00 GMT', now)).toEqual({ name: 'AuthToken', value: null });
    expect(parseSetCookie('AuthToken=abc; expires=Thu, 01 Jan 2099 00:00:00 GMT; Secure', now)).toEqual({ name: 'AuthToken', value: 'abc' });
    expect(parseSetCookie('AuthToken=abc; expires=garbage', now)).toEqual({ name: 'AuthToken', value: 'abc' });
  });
  it('ignores a header with no name', () => {
    expect(parseSetCookie('=abc', now)).toBeNull();
    expect(parseSetCookie('novalue', now)).toBeNull();
    expect(parseSetCookie(' =abc', now)).toBeNull();
  });
});

describe('createSignInFetch (the default single-hop fetch)', () => {
  function agent() {
    const mock = new MockAgent();
    mock.disableNetConnect();
    return mock;
  }

  it('returns a redirect unfollowed, with every Set-Cookie and the headers', async () => {
    const mock = agent();
    mock
      .get('https://war.app')
      .intercept({ path: '/LogIn', method: 'POST' })
      .reply(302, '', {
        headers: { location: '/MultiPlayer', 'set-cookie': [`AuthToken=${FAKE_TOKEN}; Path=/`, 'AWSELB=y'] },
      });
    const res = await createSignInFetch({ dispatcher: mock })(SIGN_IN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Email=x',
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/MultiPlayer');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.setCookies).toEqual([`AuthToken=${FAKE_TOKEN}; Path=/`, 'AWSELB=y']);
    await mock.close();
  });

  it('reads the body, and refuses one past the byte cap', async () => {
    const mock = agent();
    mock.get('https://war.app').intercept({ path: '/LogIn', method: 'GET' }).reply(200, FORM_PAGE);
    mock.get('https://war.app').intercept({ path: '/LogIn', method: 'GET' }).reply(200, 'x'.repeat(100));
    const fetch = createSignInFetch({ dispatcher: mock, maxBytes: 4096 });
    const init = { method: 'GET' as const, headers: {}, signal: new AbortController().signal };
    expect((await fetch(SIGN_IN_URL, init)).body).toBe(FORM_PAGE);
    const small = createSignInFetch({ dispatcher: mock, maxBytes: 10 });
    await expect(small(SIGN_IN_URL, init)).rejects.toMatchObject({ kind: 'too_large' });
    await mock.close();
  });

  it('builds its own public-only dispatcher by default (refused here: tests never reach war.app)', async () => {
    const fetch = createSignInFetch();
    await expect(fetch(SIGN_IN_URL, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });

  it('signIn over the default fetch end to end, on a mock war.app', async () => {
    const mock = agent();
    const origin = mock.get('https://war.app');
    origin.intercept({ path: '/LogIn', method: 'GET' }).reply(200, FORM_PAGE, { headers: { 'set-cookie': `jses_WS60=${JSES}` } });
    origin
      .intercept({
        path: '/LogIn',
        method: 'POST',
        headers: { cookie: `jses_WS60=${JSES}` },
        body: (b: string) => new URLSearchParams(b).get('Password') === PASSWORD,
      })
      .reply(302, '', { headers: { location: '/', 'set-cookie': `AuthToken=${FAKE_TOKEN}; Path=/; HttpOnly` } });
    await expect(
      signIn({ email: EMAIL, password: PASSWORD }, { fetch: createSignInFetch({ dispatcher: mock }) }),
    ).resolves.toEqual({ authToken: FAKE_TOKEN });
    await mock.close();
  });
});
