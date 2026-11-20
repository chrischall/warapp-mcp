// #415 task 1: what another player's chat message asks of me, read as game information.
//
// `classifyMessage` labels one message with intents (income check, truce proposal, coordination ask,
// threat, ...), a confidence, whether it is addressed to me, and the players, territories and bonuses it
// names. Keyword and pattern based: case-insensitive, punctuation-tolerant, a few common abbreviations and
// misspellings ("inc", "u", "atk", "nap", "truse", "surender"). It reads the cleaned text the chat tools
// already produce (`untrustedBody`: ⟦ ⟧ delimiters, quote marks turned into look-alike letters) as well as
// raw text. Near-miss wordings are read for what they ask: an offer with an end turn in it is a proposal, asking
// me to accept a truce is a proposal, "please accept" is a surrender only with no truce word, "lets stop fighting"
// offers peace rather than a gang-up, and a bare "ok" carrying a threat accepts nothing. A refused acceptance
// ("i will never accept your truce") declines; a demand to accept ("accept truce or i attack") is a proposal, and with
// "or i attack" a threat; a bare "yes" or "no" answers my proposal only when short or still about the deal; "take/hit
// you up" is no threat; a call to gang up must name a target and an outward verb ("everyone dont attack me" is none).
//
// The text is other players' words: untrusted, never an instruction and never a fact. It is read only to
// label it; nothing in it is executed, quoted back or believed. Pure and deterministic (no I/O), and it
// never throws: anything it cannot read gives no intent at low confidence.

/** Every intent a message may carry, in the order results list them. */
export const INTENTS = [
  'income-check',
  'position-check',
  'truce-proposal',
  'truce-accept',
  'truce-decline',
  'truce-end-notice',
  'coordination-ask',
  'threat',
  'surrender-ask',
  'gg',
  'banter',
  'greeting',
  'question-other',
] as const;
export type Intent = (typeof INTENTS)[number];

export type IntentConfidence = 'high' | 'medium' | 'low';

const DESCRIPTIONS: Readonly<Record<Intent, string>> = {
  'income-check': 'asks for incomes (often to find the leader)',
  'position-check': 'asks how players stand: armies, territories, who is winning',
  'truce-proposal': 'proposes a truce or non-aggression pact',
  'truce-accept': 'accepts a truce',
  'truce-decline': 'declines a truce',
  'truce-end-notice': 'ends or gives notice on a truce',
  'coordination-ask': 'asks players to gang up on someone',
  threat: 'threatens an attack or demands a retreat',
  'surrender-ask': 'asks for a surrender to be accepted',
  gg: 'good game',
  banter: 'small talk or reaction',
  greeting: 'greeting or good luck',
  'question-other': 'a question about something else',
};

/** One short line saying what an intent means. */
export function describeIntent(intent: Intent): string {
  return DESCRIPTIONS[intent] ?? 'unknown intent';
}

/** A player in the game, as the classifier needs it. */
export interface ChatIntentPlayer {
  /** The player's id (whichever id space the caller uses; `mentions.players` gives it back). */
  id: number;
  name: string;
  /** The signed-in account's seat. */
  isMe?: boolean;
  team?: number | null;
}

/** A named map place: a territory or a bonus. */
export interface NamedPlace {
  id: number;
  name: string;
}

/** What the classifier knows about the game around a message. */
export interface ChatIntentContext {
  players?: readonly ChatIntentPlayer[];
  territories?: readonly NamedPlace[];
  bonuses?: readonly NamedPlace[];
  /** My own recent messages in this conversation, oldest first (to read a reply to a proposal of mine). */
  myRecentMessages?: readonly string[];
  /** A private message to me. */
  toMe?: boolean;
}

export interface ChatMentions {
  /** Player ids named in the text, ascending. */
  players: number[];
  /** Territory ids named, ascending. */
  territories: number[];
  /** Bonus ids named, ascending. */
  bonuses: number[];
}

export interface ClassifiedMessage {
  /** In {@link INTENTS} order, each once; empty when nothing was recognised. */
  intents: Intent[];
  confidence: IntentConfidence;
  /** A private message to me, one naming me, or a reply to a truce proposal of mine. */
  addressedToMe: boolean;
  mentions: ChatMentions;
}

/** How many of my recent messages are looked at for an open proposal. */
const RECENT_MESSAGES = 5;
/** The longest text read (war.app's send limit). */
const MAX_TEXT = 2000;
/** Names shorter than this are not matched (too likely to be an ordinary word or letter). */
const MIN_NAME = 2;

const TOKEN_SUBS: Readonly<Record<string, string>> = {
  u: 'you',
  ya: 'you',
  ur: 'your',
  r: 'are',
  pls: 'please',
  plz: 'please',
  plez: 'please',
  atk: 'attack',
  att: 'attack',
  inc: 'income',
  thx: 'thanks',
  ty: 'thanks',
  tx: 'thanks',
  surender: 'surrender',
  surrender: 'surrender',
  truse: 'truce',
  truece: 'truce',
  treuce: 'truce',
};

const safeString = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  } catch {
    return '';
  }
};

/**
 * Lower-case words only: delimiters and apostrophes dropped, every other mark a space. The quote
 * look-alikes `untrustedText` writes are letters (ʼ U+02BC, ʺ U+02BA: Lm), so they are named here:
 * the apostrophe joins its word ("donʼt" → "dont"), the double quote separates ("ʺAlphaʺ" → "alpha").
 */
function flatten(raw: string): string {
  return raw
    .slice(0, MAX_TEXT * 2)
    .normalize('NFKC')
    .replace(/[⟦⟧ʺ]/g, ' ')
    .toLowerCase()
    .replace(/['`‘’ʼ′]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const substitute = (flat: string): string =>
  flat
    .split(' ')
    .map((w) => TOKEN_SUBS[w] ?? w)
    .join(' ');

const TRUCE_WORD = /\b(truce|truces|nap|peace|ceasefire|cease fire|non aggression|nonaggression|alliance|ally)\b/;
const MUTUAL_NO_ATTACK = /\bdont (attack|hit) me\b.*\b(i wont|i will not|i dont|and i wont|ill not)\b/;
const TRUCE_END = /\b(over|ends?|ending|break|breaking|broken|cancel|cancell?ing|cancell?ed|off|expires?|expired|done)\b/;
const TRUCE_NOUN = '(truce|truces|nap|peace|ceasefire|cease fire|non aggression|nonaggression|alliance|deal)';
/** An end said of the truce itself ("the truce is over", "ending our truce", "breaking the nap", "done with our truce"). */
const TRUCE_ENDED = new RegExp(
  `\\b${TRUCE_NOUN}( pact)? (is |s |will |will be |has |has been )?(over|off|done|ended|ends|ending|broken|cancell?ed|expired|expires)\\b` +
    `|\\b(end|ends|ending|break|breaking|cancel|cancell?ing|done with|over with) (the |our |this |my |your )?${TRUCE_NOUN}\\b`,
);
/** Wording that offers rather than states: an offer with an end turn in it is still an offer. */
const OFFER_WORD = /\b(want|wanna|lets|let us|how about|offer|propose|interested|please|until turn|till turn|can we|shall we|should we)\b/;
/** Asking the other side to accept or agree is a proposal, not an acceptance. */
const ASK_TO_ACCEPT = /\b(you|please)( \w+)? (accept|agree)\b/;
/** A peace overture without a truce word ("lets stop fighting", "stop attacking each other"). */
const PEACE_OVERTURE =
  /\b(stop|quit|end) (the )?(fighting|war|warring)\b|\b(fighting|attacking|hitting|attack|hit) (each other|one another)\b/;
const GIVING_NOTICE = /\bgiv(e|ing) (you )?notice\b/;
/**
 * A demand to accept, at the start of the message ("accept truce or i attack", "accept the nap now", "agree to
 * peace or else"): a proposal (pressed), never an acceptance. A bare "agree" names no deal and stays a reply.
 */
const DEMAND_ACCEPT = new RegExp(
  `^(please |just |now |so )?(accept|agree)( to| on)?( a| an| the| my| our| this| that| your| ur)? ${TRUCE_NOUN}\\b`,
);
/** Refusing to accept ("i will never accept", "wont accept", "dont agree", "not accepting"); "if you dont accept" is no refusal. */
const NEGATED_ACCEPT =
  /(?:^|\b(?:i|we|im)(?: will| would| do| am| can| shall)? )(never|not|wont|dont|do not|cant|cannot|wouldnt|would not|will not|refuse to)( ever| really| even)? (accept|accepting|accepted|agree|agreeing|agreed)\b/;
const ACCEPT_WORD = /\b(accept|accepted|accepting|agree|agreed|deal|confirmed)\b/;
const DECLINE_WITH_TRUCE = /\bno (truce|nap|peace|deal|alliance)\b|\b(decline|declined|reject|rejected|refuse|refused)\b|\bnot interested\b/;
const REPLY_ACCEPT =
  /^(deal|agreed|agree|ok|okay|k|kk|sure|yes|yep|yeah|yup|accepted|i accept|i agree|fine|alright|sounds good|done|you got a deal)\b/;
/** A bare decline at the start of a reply (longest wordings first, so the rest is what follows the whole phrase). */
const REPLY_DECLINE_START = /^(no thanks|no deal|no way|not interested|i decline|declined|nope|nah|pass|no)\b/;
/** Most words after a bare accept or decline for it still to be a reply ("nah im good"), not another sentence ("no way you are winning"). */
const REPLY_DECLINE_REST = 2;
/** Refusing a truce: a negated want of one ("i dont want a truce", "no want peace"). */
const NEGATED_WANT = new RegExp(
  `\\b(i )?(dont|do not|did not|didnt|not|no|never|wont|will not)( really| even)? (want|wanna|need)( to make| to have)?( a| an| any| the| your| this| that| our| ur)? ${TRUCE_NOUN}\\b`,
);
const NEGATED_WANT_ALL = new RegExp(NEGATED_WANT.source, 'g');

/** What follows a bare reply still makes it one: short (and no call to attack), or it speaks of the deal. */
function replyRestFits(rest: string): boolean {
  if (!rest) return true;
  if (TRUCE_WORD.test(rest) || /\bdeal\b/.test(rest)) return true;
  return rest.split(' ').length <= REPLY_DECLINE_REST && !/\b(attack|hit|kill|crush|stop|focus)\b/.test(rest);
}

/** A bare accept of my open proposal: short, or what follows still speaks of the deal ("yes Redcrane is winning" is none). */
function replyAccepts(s: string): boolean {
  const m = REPLY_ACCEPT.exec(s);
  return m !== null && replyRestFits(s.slice(m[0].length).trim());
}

/** A bare decline of my open proposal: short, or what follows still speaks of the deal. */
function replyDeclines(s: string): boolean {
  if (/\bnot interested\b/.test(s)) return true;
  const m = REPLY_DECLINE_START.exec(s);
  if (!m) return false;
  return replyRestFits(s.slice(m[0].length).trim());
}

type Strength = 'high' | 'medium';

interface Truce {
  proposal: Strength | null;
  accept: Strength | null;
  decline: Strength | null;
  end: Strength | null;
  /** The proposal is the mutual no-attack wording, which reads like a threat and is not one. */
  mutual: boolean;
}

/** The truce intents of one flattened, substituted text; `proposalOpen` reads a bare reply as one. */
function truceOf(s: string, hasQuestion: boolean, proposalOpen: boolean, hostile = false): Truce {
  const r: Truce = { proposal: null, accept: null, decline: null, end: null, mutual: false };
  const truce = TRUCE_WORD.test(s);
  const refused = truce && NEGATED_WANT.test(s);
  const refusedAccept = NEGATED_ACCEPT.test(s);
  const demand = truce && (DEMAND_ACCEPT.test(s) || ASK_TO_ACCEPT.test(s));
  // A negated want offers nothing: "i dont want a truce" is no offer, whatever else the message says.
  const offer = hasQuestion || demand || OFFER_WORD.test(s.replace(NEGATED_WANT_ALL, ' '));
  if (GIVING_NOTICE.test(s)) r.end = truce ? 'high' : 'medium';
  else if (truce && TRUCE_ENDED.test(s)) r.end = 'high';
  // An end word near a truce word, said of something else ("done fighting", "then it ends"): only when not an offer.
  else if (truce && !offer && TRUCE_END.test(s)) r.end = 'medium';
  if (proposalOpen && replyDeclines(s)) r.decline = 'high';
  else if (truce && (refused || refusedAccept || DECLINE_WITH_TRUCE.test(s))) r.decline = 'medium';
  // A refused acceptance answering my proposal declines it ("wont accept"), though it names no truce.
  else if (proposalOpen && refusedAccept) r.decline = 'medium';
  if (!r.decline && !refusedAccept) {
    // A bare "ok" with a threat in it does not accept anything; nor does a demand to accept.
    if (proposalOpen && !hostile && !demand && replyAccepts(s)) r.accept = 'high';
    else if (truce && !demand && ACCEPT_WORD.test(s)) r.accept = 'medium';
  }
  if (!r.end && !r.decline && !r.accept) {
    if (MUTUAL_NO_ATTACK.test(s)) {
      r.proposal = 'high';
      r.mutual = true;
    }
    else if (truce) r.proposal = offer ? 'high' : 'medium';
    else if (offer && !hostile && PEACE_OVERTURE.test(s)) r.proposal = 'medium';
  }
  return r;
}

/** Each detector: the strength it fired with, else null. */
function incomeCheck(s: string, hasQuestion: boolean): Strength | null {
  if (!/\bincome\b/.test(s)) return null;
  if (/\bincome check\b/.test(s) || /\b(whats|what is|what are|how much|hows)\b.*\bincome\b/.test(s)) return 'high';
  if (/\b(your|everyones|everyone|yalls|all)\b.*\bincome\b/.test(s) && (hasQuestion || /\b(whats|what|how)\b/.test(s))) return 'high';
  if (hasQuestion && !/\bmy income\b/.test(s)) return 'medium';
  return null;
}

function positionCheck(s: string): Strength | null {
  if (/\bwho (is|s)? ?winning\b|\bwhos winning\b|\bwhos leading\b|\bwho is leading\b/.test(s)) return 'high';
  if (/\bhow many (armies|army|troops|territories|territory|terrs|terries|bonuses)\b/.test(s)) return 'high';
  if (/\bhow are (you|yall|everyone|you all|things)\b.*\b(doing|going)\b/.test(s) || /^how are (you|yall|everyone)\b/.test(s)) return 'medium';
  if (/\bhows it going\b|\bhow is it going\b|\bhows everyone\b|\bhow is everyone\b/.test(s)) return 'medium';
  return null;
}

/** Whom a call to gang up names: a player (given by the caller), or a word standing for one. */
const COORDINATION_TARGET = /\b(leader|him|her|them|whoever|the (top|biggest|strongest|big) (one|guy|player))\b/;

function coordinationAsk(s: string, namesPlayer: boolean): Strength | null {
  if (/\b(gang up|team up|dogpile|dog pile|ally against|work together against)\b/.test(s)) return 'high';
  if (/\bhelp\b.*\b(vs|versus|against)\b/.test(s)) return 'high';
  // "lets stop fighting" / "stop attacking each other" offer peace; they name no one to gang up on.
  const t = s
    .replace(/\b(stop|quit) (attacking|hitting) (me|us|each other|one another)\b/g, ' ')
    .replace(new RegExp(PEACE_OVERTURE.source, 'g'), ' ')
    // A negated or self-directed verb asks no one to attack anyone ("everyone dont attack me").
    .replace(/\b(dont|do not|never|wont|will not|not|stop) (attack|attacking|hit|hitting|kill|killing|crush|focus|focusing|stop)\b/g, ' ')
    .replace(/\b(attack|hit|kill|crush|stop) (me|us|myself)\b/g, ' ');
  if (
    (namesPlayer || COORDINATION_TARGET.test(t)) &&
    /\b(lets|let us|we need to|we should|we must|we have to|everyone|everybody|all of us|yall|someone|anyone)\b.*\b(attack|hit|stop|kill|take down|take out|focus|crush)\b/.test(t)
  ) {
    return 'high';
  }
  if (/\b(is|s|hes|shes|theyre|are) (winning|leading|too strong|too big|running away)\b/.test(s) && /\b(help|stop|together|gang|attack)\b/.test(s)) {
    return 'high';
  }
  return null;
}

function threat(s: string): Strength | null {
  if (/\b(i will|ill|im going to|im gonna|i am going to|i am gonna|gonna)( now)? (attack|kill|wipe|destroy|crush|hit|eliminate|end|take) you\b(?! up\b)/.test(s)) return 'high';
  // "accept truce or i attack", "or well hit you": an ultimatum.
  if (/\bor (i|we|ill|well|i will|we will|im gonna|im going to)( just)? (attack|kill|wipe|destroy|crush|hit|eliminate|end|take|break)\b/.test(s)) return 'high';
  if (/\b(i will|ill|im going to|im gonna|i am going to|i am gonna) (wipe|destroy|crush|eliminate|end) you\b/.test(s)) return 'high';
  if (/\b(wipe|destroy|crush) you out\b|\bill wipe you\b/.test(s)) return 'high';
  if (/\bback off\b|\bcoming for you\b|\bor else\b|\byoull regret\b|\byou will regret\b/.test(s)) return 'high';
  if (/\battack me and\b.*\b(regret|sorry|pay|die|destroy|end you)\b/.test(s)) return 'high';
  if (/\bget out of\b|\bstay out of\b|\bleave my\b/.test(s)) return 'medium';
  return null;
}

function surrenderAsk(s: string): Strength | null {
  if (/\baccept (my |the |our )?surrender\b|\bsurrender accept/.test(s)) return 'high';
  // "please accept the truce" asks for a truce, not a surrender.
  if (/\bplease accept\b/.test(s) && !TRUCE_WORD.test(s)) return 'high';
  if (/\bi (surrender|resign|concede)\b|\bi m surrendering\b|\bim surrendering\b/.test(s)) return 'high';
  // "i give up" / "i quit" only at the end of the message or followed by gg or an ask ("i give up on you lol" is not one).
  if (/\bi (give up|quit)( (gg|ggs|ggwp|good game|wp|well played|accept|please|i surrender)\b.*)?$/.test(s)) return 'high';
  return null;
}

const gg = (s: string): Strength | null => (/\b(gg|ggs|ggwp|good game|good games|well played|wp)\b/.test(s) ? 'high' : null);

function greeting(s: string): Strength | null {
  if (/^(hi|hey|hello|hiya|yo|sup|howdy|greetings|hola|heya)\b/.test(s)) return 'high';
  if (/\b(hi|hello|hey) (all|everyone|everybody|guys|yall|there)\b/.test(s)) return 'high';
  if (/\b(gl|glhf|good luck|have fun|hf)\b/.test(s)) return 'high';
  return null;
}

const banter = (s: string): Strength | null =>
  /\b(lol|lmao|rofl|ha(ha)+|he(he)+|thanks|thank you|nice|wow|lucky|unlucky|rip|oof|omg|bruh|well done|damn|ouch)\b/.test(s)
    ? 'medium'
    : null;

/** The ids of the places whose (flattened) name stands as whole words in the padded text. */
function namedIn(padded: string, places: readonly { id: number; name: string }[] | undefined): number[] {
  const ids = new Set<number>();
  for (const p of places ?? []) {
    if (!p || typeof p.id !== 'number') continue;
    const name = flatten(safeString(p.name));
    if (name.length < MIN_NAME) continue;
    if (padded.includes(` ${name} `)) ids.add(p.id);
  }
  return [...ids].sort((a, b) => a - b);
}

const EMPTY = (): ClassifiedMessage => ({
  intents: [],
  confidence: 'low',
  addressedToMe: false,
  mentions: { players: [], territories: [], bonuses: [] },
});

/** Whether any of my recent messages proposes a truce. */
function proposalOpen(mine: readonly string[] | undefined): boolean {
  if (!Array.isArray(mine)) return false;
  return mine.slice(-RECENT_MESSAGES).some((m) => {
    const raw = safeString(m);
    return truceOf(substitute(flatten(raw)), raw.includes('?'), false).proposal !== null;
  });
}

/** Label one message from another player. Never throws. */
export function classifyMessage(text: string, ctx: ChatIntentContext): ClassifiedMessage {
  try {
    const raw = safeString(text).slice(0, MAX_TEXT * 2);
    const c: ChatIntentContext = ctx && typeof ctx === 'object' ? ctx : {};
    const flat = flatten(raw);
    if (!flat) return EMPTY();
    const s = substitute(flat);
    const hasQuestion = raw.includes('?');
    const open = proposalOpen(c.myRecentMessages);

    const padded = ` ${flat} `;
    const players = Array.isArray(c.players) ? c.players : [];
    const mentions: ChatMentions = {
      players: namedIn(padded, players),
      territories: namedIn(padded, Array.isArray(c.territories) ? c.territories : []),
      bonuses: namedIn(padded, Array.isArray(c.bonuses) ? c.bonuses : []),
    };

    const found = new Map<Intent, Strength>();
    const put = (intent: Intent, strength: Strength | null): void => {
      if (strength) found.set(intent, strength);
    };
    put('income-check', incomeCheck(s, hasQuestion));
    put('position-check', positionCheck(s));
    const threatStrength = threat(s);
    const truce = truceOf(s, hasQuestion, open, threatStrength !== null);
    put('truce-proposal', truce.proposal);
    put('truce-accept', truce.accept);
    put('truce-decline', truce.decline);
    put('truce-end-notice', truce.end);
    put('coordination-ask', coordinationAsk(s, mentions.players.length > 0));
    // A mutual no-attack offer is a proposal, not a threat; a coercive one ("… if you dont accept truce") is both.
    if (!truce.mutual) put('threat', threatStrength);
    put('surrender-ask', surrenderAsk(s));
    put('gg', gg(s));
    put('banter', banter(s));
    put('greeting', greeting(s));
    if (found.size === 0 && hasQuestion) found.set('question-other', 'medium');

    const intents = INTENTS.filter((i) => found.has(i));
    let confidence: IntentConfidence = 'low';
    if (intents.some((i) => i !== 'question-other' && found.get(i) === 'high')) confidence = 'high';
    else if (intents.some((i) => i !== 'question-other')) confidence = 'medium';

    const meIds = new Set(players.filter((p) => p?.isMe).map((p) => p.id));
    const repliesToMe = open && (found.has('truce-accept') || found.has('truce-decline'));
    const addressedToMe = c.toMe === true || mentions.players.some((id) => meIds.has(id)) || repliesToMe;
    return { intents, confidence, addressedToMe, mentions };
  } catch {
    return EMPTY();
  }
}
