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
// "i accept your surrender" accepts nothing of mine; "please accept the deal / my offer" asks no surrender; "we should
// attack you" and "you are dead" threaten; "i need a nap" is sleep, not a pact. A negated or conditional end gives no
// notice ("i wont break our truce", "if you break the truce"); a question about the truce's state ("is the truce over?")
// is a plain question; "dont gang up on me" asks for no gang-up; "peace out" is a goodbye. A threat needs a first-person
// subject and no negation ("im not gonna attack you" promises peace; "who is gonna attack you" asks), and my own name
// counts as "you" ("i will kill <me>"). An end is high-confidence notice only when the truce is said to be over or the
// sender ends it: a proposal to end ("lets end the truce") or another player's act ("X is breaking the truce") is
// medium, a modal question ("should we end the truce?") a plain question, an opinion none, and a dare ("break the
// truce and you die") a threat. "i resign" / "i concede" ask a surrender only of the game. Each intent carries its own
// confidence in `strengths`; `confidence` is the message's (its strongest intent). A conditional or temporal clause
// about the truce's state ("if the truce is over", "until the truce is over i wont attack") carries no truce intent;
// restating the agreed end turn ("remember our truce ends turn 10") is medium notice; a reported break ("you broke
// our truce") is medium notice, never a proposal; peace as a state ("we are at peace") and an alliance against
// someone ("ally with me against X", a gang-up) offer no truce; "no deal" declines; "I surrender? never" asks none.
// #460: accepting the terms ("i accept your terms") is a medium truce-accept, and a counter with terms of its own ("if
// youre good with it, i take X but i wont go to Y", "if thats acceptable i accept your terms") a medium truce-proposal
// too; a greeting opening a message of more than `GREETING_ALONE_WORDS` words is the label only when nothing else matches.
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
  /** The message's confidence: high when any intent (but question-other) is high. */
  confidence: IntentConfidence;
  /** Each intent's own confidence (act on one intent by its own entry, not the message's). */
  strengths: Partial<Record<Intent, IntentConfidence>>;
  /** A private message to me, one naming me, or a reply to a truce proposal of mine. */
  addressedToMe: boolean;
  mentions: ChatMentions;
}

/** How many of my recent messages are looked at for an open proposal. */
const RECENT_MESSAGES = 5;
/** #460: a greeting opening a message longer than this is the label only when nothing else in it matches. */
const GREETING_ALONE_WORDS = 6;
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

/** A nap to sleep, not a non-aggression pact ("i need a nap", "taking a nap", "nap time"). */
const SLEEP_NAP =
  /\b(need|needs|needed|take|takes|taking|took|gonna take|going to take)( a| an)?( quick| little| short| long)? nap\b|\bbrb( for)?( a| an)?( quick| little| short| long)? nap\b|\bnap (time|now brb|brb)\b|\bnaptime\b/g;
/** "peace out" is a goodbye, not an offer of peace. */
const PEACE_OUT = /\bpeace out\b/g;

const substitute = (flat: string): string =>
  flat
    .split(' ')
    .map((w) => TOKEN_SUBS[w] ?? w)
    .join(' ')
    .replace(SLEEP_NAP, (m) => m.replace(/\bnap\b/, 'snooze'))
    .replace(PEACE_OUT, 'bye');

const TRUCE_WORD = /\b(truce|truces|nap|peace|ceasefire|cease fire|non aggression|nonaggression|alliance|ally)\b/;
const MUTUAL_NO_ATTACK = /\bdont (attack|hit) me\b.*\b(i wont|i will not|i dont|and i wont|ill not)\b/;
const TRUCE_END = /\b(over|ends?|ending|break|breaking|broken|cancel|cancell?ing|cancell?ed|off|expires?|expired|done)\b/;
const TRUCE_NOUN = '(truce|truces|nap|peace|ceasefire|cease fire|non aggression|nonaggression|alliance|deal)';
/** An end said of the truce itself ("the truce is over", "our nap has ended"): notice whoever says it. */
const TRUCE_STATE_ENDED = new RegExp(
  `\\b${TRUCE_NOUN}( pact)? (is |s |will |will be |has |has been )?(over|off|done|ended|ends|ending|broken|cancell?ed|expired|expires)\\b`,
);
/** An act that ends the truce ("ending our truce", "breaking the nap", "done with our truce", "i resign from this alliance"). */
const TRUCE_ACT_ENDED = new RegExp(
  `\\b(end|ends|ending|break|breaking|cancel|cancell?ing|done with|over with|resign from|resigning from|leave|leaving|quit|quitting|withdraw from|withdrawing from) (the |our |this |my |your )?${TRUCE_NOUN}\\b`,
  'g',
);
/** Auxiliaries between a subject and the end verb ("i will", "bravo is", "im going to"). */
const AUX_TAIL = /( (am|are|is|s|will|would|shall|be|been|have|has|gonna|going|to|just|now|hereby|officially|really|formally|about))+$/;
/** The sender as the subject of the end, or nothing before it but a filler ("ok im breaking", "breaking the nap"). */
const FIRST_PERSON_TAIL = /\b(i|im|ive|ill|id|we|were|well|weve|i am|we are|ok|okay|so|fyi|btw|hey|yo|alright|sorry|guys|then|and|but|now|hereby|officially)$/;
/** A proposal to end, not notice of one ("lets end the truce", "maybe we should break the nap"). */
const PROPOSE_END_TAIL = /\b(lets|let us|should|could|shall|maybe|perhaps|how about|what if)( \w+){0,2}$/;
/** A modal question or suggestion about ending ("should we end the truce?", "can we cancel the nap"). */
const MODAL_END = /^((wait|so|hey|hmm|lol|um|uh|ok|okay|yo|bro|dude|then) )*(should|shall|could|can|would|will|must|maybe|perhaps) (we|i|you|they|us)\b/;
/** An opinion about ending the truce ("ending the truce would be dumb"): no notice. */
const END_OPINION = new RegExp(
  `^(ending|breaking|cancell?ing) (the |our |this |that |a )?${TRUCE_NOUN} (would|is|isnt|was|will|could|might|seems|sounds|makes)\\b`,
);
/** A dare: "break the truce and you die" warns of what follows their break; it gives no notice and offers nothing. */
const DARE_BREAK = new RegExp(
  `^((go ahead|try|just|you) (and |to )?)?(break|end|cancel) (the |our |this |that |a )?${TRUCE_NOUN} and (you|youll|you will|youre|you are|i|ill|i will|we|well|we will)\\b`,
);

/** A break reported in the past ("you broke our truce", "Redcrane broke the truce"): information, never my notice. */
const BREACH_REPORT = new RegExp(`\\b(broke|betrayed|backstabbed)( the| our| this| that| my| your)? ${TRUCE_NOUN}\\b`);
/**
 * A conditional or temporal clause about the truce's state ("if the truce is over", "until the truce is over",
 * "let me know when the truce ends"): it states no end and offers nothing, so the truce detectors never see it.
 */
const CONDITIONAL_STATE = new RegExp(
  `\\b(if|when|whenever|once|unless|until|till|til|after|before|whether|as soon as) (the |our |this |that |my |your |a )?${TRUCE_NOUN}( pact)? (is |s |will |will be |has |has been |was |gets |get |is going to |is gonna )?(over|off|done|end|ends|ended|ending|break|breaks|broken|cancell?ed|expire|expires|expired)\\b`,
  'g',
);
/** "peace" said of a state, not offered ("we are at peace now", "peace and love", "in peace times"). */
const PEACE_STATEMENT = /\b(at peace|in peace|peace and love|peace times|peacetime|peaceful|peacefully)\b/g;
/** An alliance against someone is a call to gang up, not a truce with me ("ally with me against Redcrane"). */
const ALLY_AGAINST = /\b(ally|allies|alliance|allied|allying)( \w+){0,3} against\b/g;
/** Restating the agreed end ("our truce expires on turn 10 as agreed", "remember our truce ends turn 10"): a reminder. */
const AGREED_REMINDER = /\b(as agreed|as we agreed|like we agreed|as promised|as planned|remember|reminder|dont forget|just so you know)\b/;
const AS_AGREED = /\b(as|like) (we )?(agreed|promised|planned)\b/g;
const END_TURN_STATED = /\b(turn|t) \d+\b/;

/** How surely an end of the truce is the sender's notice: an end of the truce stated, or one the sender does. */
function endOf(e: string): Strength | null {
  if (TRUCE_STATE_ENDED.test(e)) return 'high';
  let found: Strength | null = BREACH_REPORT.test(e) ? 'medium' : null;
  for (const m of e.matchAll(TRUCE_ACT_ENDED)) {
    const before = ` ${e.slice(0, m.index).trim()}`;
    if (PROPOSE_END_TAIL.test(before)) {
      found = 'medium';
      continue;
    }
    const subject = before.replace(AUX_TAIL, '').trim();
    if (!subject || FIRST_PERSON_TAIL.test(subject)) return 'high';
    // Someone else ends it ("Bravo is breaking the truce with me"): a report, not my notice.
    found = 'medium';
  }
  return found;
}
/** Wording that offers rather than states: an offer with an end turn in it is still an offer. */
const OFFER_WORD = /\b(want|wanna|lets|let us|how about|offer|propose|interested|please|until turn|till turn|can we|shall we|should we)\b/;
/** Asking the other side to accept or agree is a proposal, not an acceptance. */
const ASK_TO_ACCEPT = /\b(you|please)( \w+)? (accept|agree)\b/;
/** A peace overture without a truce word ("lets stop fighting", "stop attacking each other"). */
const PEACE_OVERTURE =
  /\b(stop|quit|end) (the )?(fighting|war|warring)\b|\b(fighting|attacking|hitting|attack|hit) (each other|one another)\b/;
const GIVING_NOTICE = /\bgiv(e|ing) (you )?notice\b/;
/** End wording a negation or another player's (conditional) act takes back: never notice from the sender. */
const END_VERB =
  '(end|ends|ending|ended|break|breaks|breaking|broke|broken|cancel|cancels|cancell?ing|cancell?ed|over|off|done|expire|expires|expired|giv(e|ing) (you )?notice)';
/** "i wont break our truce", "dont end the truce", "the truce is not over", "im not giving notice". */
const NEGATED_END = new RegExp(
  `\\b(dont|do not|doesnt|does not|didnt|did not|wont|will not|wouldnt|would not|never|not|cant|cannot|isnt|arent|aint|no need to)( (ever|really|even|going|to|gonna|be|planning|trying|about|actually))* ${END_VERB}\\b`,
  'g',
);
/** "if you break the truce", "you break the truce and ...": a warning about their act, not my notice. */
const OTHERS_END = /\b(if |when |once |unless )?(you|they|he|she|someone|anyone)( ever| even| dare| dare to)? (end|ends|break|breaks|cancel|cancels)\b/g;
/** A question about the truce's state ("did you break the truce?", "is the truce over?", "who broke the truce?"). */
const STATE_QUESTION =
  /^((wait|so|hey|hmm|lol|um|uh|ok|okay|yo|bro|dude) )*(did|didnt|is|isnt|was|wasnt|has|hasnt|have|havent|who|whos|why|when|how come|are|arent|were)\b/;
const PAST_END = /\b(broke|broken|ended|over|off|ending|end|ends|break|breaking|cancell?ed|expired|done)\b/;
/** A promise not to attack ("i wont attack you", "no i will not attack you"): truce-ish. */
const NO_ATTACK_PROMISE =
  /\b(i|we)( will| would| do| am)? (wont|will not|not|never|dont|do not)( ever| really)? (attack|hit) you\b|\b(im|i am|we are|were|we re) (not|never)( ever| really)?( going to| gonna)? (attack|hit) you\b|\b(we arent|i aint|we aint)( ever| really)?( going to| gonna)? (attack|hit) you\b/;
/** A bare "deal?" asks for a deal. */
const DEAL_QUESTION = /^(deal|a deal|is it a deal|do we have a deal|we have a deal|deal or no deal)$/;
/**
 * A demand to accept, at the start of the message ("accept truce or i attack", "accept the nap now", "agree to
 * peace or else"): a proposal (pressed), never an acceptance. A bare "agree" names no deal and stays a reply.
 */
const DEMAND_ACCEPT = new RegExp(
  `^(please |just |now |so )?(accept|agree)( to| on)?( a| an| the| my| our| this| that| your| ur)? ${TRUCE_NOUN}\\b` +
    `|\\b(and|so|now|then|just) (accept|agree to|agree on)( a| an| the| my| our| this| that| your| ur)? ${TRUCE_NOUN}\\b`,
);
/** Refusing to accept ("i will never accept", "wont accept", "dont agree", "not accepting"); "if you dont accept" is no refusal. */
const NEGATED_ACCEPT =
  /(?:^|\b(?:i|we|im)(?: will| would| do| am| can| shall)? )(never|not|wont|dont|do not|cant|cannot|wouldnt|would not|will not|refuse to)( ever| really| even)? (accept|accepting|accepted|agree|agreeing|agreed)\b/;
const ACCEPT_WORD = /\b(accept|accepted|accepting|agree|agreed|deal|confirmed)\b|\btake you up on\b/;
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

/** A surrender named: accepting one is not accepting my truce ("i accept your surrender"). */
const SURRENDER_WORD = /\b(surrender|surrendering|surrendered|resignation|resign|concede|concession)\b/;
/** What an accept verb may take and still accept my proposal: the deal itself, or a pronoun for it. */
const ACCEPT_OBJECT = new RegExp(`^(the |your |my |a |an |our |this |that )(${TRUCE_NOUN.slice(1, -1)}|offer|terms|proposal|pact)\\b`);
const ACCEPT_VERB = /^(i accept|i agree|accepted|agreed|agree)$/;

/** A bare accept of my open proposal: short, or what follows still speaks of the deal ("yes Redcrane is winning" is none). */
function replyAccepts(s: string): boolean {
  const m = REPLY_ACCEPT.exec(s);
  if (m === null) return false;
  const rest = s.slice(m[0].length).trim();
  if (SURRENDER_WORD.test(rest)) return false;
  // "i accept your X": X must be the deal, not something else of theirs or mine.
  if (ACCEPT_VERB.test(m[0]) && /^(the|your|my|a|an|our|his|her|their|this|that) \w/.test(rest) && !ACCEPT_OBJECT.test(rest)) return false;
  return replyRestFits(rest);
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

/** #460: accepting the other side's terms names no truce word ("i accept your terms", "we agree to your terms"). */
const ACCEPT_TERMS = /\b(i|we)( will| would| can| do| hereby)? (accept|agree to|agree with|take) (your|ur|the|those|these|all your|all the) (terms|offer|proposal|conditions|deal)\b/;
/** A condition put back to me ("if youre good with it", "if thats acceptable", "if you agree"): a counter, not a yes. */
const CONDITION_BACK =
  /\bif (thats|that is|this is|its|it is|that s) (acceptable|ok|okay|fine|alright|agreeable)\b|\bif (youre|you are|ur|you re) (good|ok|okay|fine|cool|alright|happy) with (it|that|this)\b|\bif you (agree|accept|are ok with|are okay with)\b/;
/** Terms of a split: one side takes some land and a side keeps out of other land ("i take X, but i wont go to Y"). */
const SPLIT_TERMS =
  /\b(i|we|you)( will| would| can| could)? (take|get|keep|have|expand into|go to)\b(?! (you|it back|that back)\b).*\b(i|we|you)( will| would)? (wont|will not|dont|do not|never|would not|wouldnt|cant|cannot) (go|move|expand|attack|enter|take|touch|hit)\b/;

/** The truce intents of one flattened, substituted text; `proposalOpen` reads a bare reply as one. */
function truceOf(text: string, hasQuestion: boolean, proposalOpen: boolean, hostile = false): Truce {
  const r: Truce = { proposal: null, accept: null, decline: null, end: null, mutual: false };
  // A conditional clause about the truce's state, peace as a state and an alliance against someone carry no truce intent.
  const s = text.replace(CONDITIONAL_STATE, ' ').replace(PEACE_STATEMENT, ' ').replace(ALLY_AGAINST, ' ').replace(/ +/g, ' ').trim();
  const truce = TRUCE_WORD.test(s);
  // Asked about, the truce's state is neither notice nor an offer: "is the truce over?" reads as a plain question.
  if (truce && hasQuestion && STATE_QUESTION.test(s) && PAST_END.test(s)) return r;
  // A dare ("break the truce and you die") is a threat only; an opinion about ending it is no notice.
  if (truce && (DARE_BREAK.test(s) || END_OPINION.test(s))) return r;
  // The end detectors read the text with negated and conditional ends taken out.
  const e = s.replace(NEGATED_END, ' ').replace(OTHERS_END, ' ');
  const ended = truce ? endOf(e) : null;
  // "should we end the truce?" asks; without the question mark it suggests (no sure notice).
  if (ended && MODAL_END.test(s)) {
    if (hasQuestion) return r;
    r.end = 'medium';
    return r;
  }
  const refused = truce && NEGATED_WANT.test(s);
  const refusedAccept = NEGATED_ACCEPT.test(s);
  const demand = truce && (DEMAND_ACCEPT.test(s) || ASK_TO_ACCEPT.test(s));
  // A negated want offers nothing: "i dont want a truce" is no offer, whatever else the message says.
  const offer = hasQuestion || demand || OFFER_WORD.test(s.replace(NEGATED_WANT_ALL, ' '));
  if (GIVING_NOTICE.test(e)) r.end = truce ? 'high' : 'medium';
  else if (ended) r.end = ended;
  // An end word near a truce word, said of something else ("done fighting", "then it ends"): only when not an offer.
  else if (truce && !offer && TRUCE_END.test(e)) r.end = 'medium';
  // Restating the agreed end turn reminds; it is no sure notice.
  if (r.end === 'high' && AGREED_REMINDER.test(s) && END_TURN_STATED.test(s)) r.end = 'medium';
  if (proposalOpen && replyDeclines(s)) r.decline = 'high';
  else if (truce && (refused || refusedAccept || DECLINE_WITH_TRUCE.test(s))) r.decline = 'medium';
  // A refused acceptance answering my proposal declines it ("wont accept"), though it names no truce.
  else if (proposalOpen && refusedAccept) r.decline = 'medium';
  // "no deal" refuses a deal, open or not.
  else if (/^no deal\b/.test(s)) r.decline = 'medium';
  if (!r.decline && !refusedAccept) {
    // A bare "ok" with a threat in it does not accept anything; nor does a demand to accept.
    if (proposalOpen && !hostile && !demand && replyAccepts(s)) r.accept = 'high';
    else if (truce && !demand && ACCEPT_WORD.test(s.replace(AS_AGREED, ' '))) r.accept = 'medium';
  }
  // #460: a conditional acceptance or a counter with terms. Medium at most: the conditions are the other side's.
  const acceptsTerms = !r.decline && !refusedAccept && ACCEPT_TERMS.test(s) && !SURRENDER_WORD.test(s);
  if (acceptsTerms && !r.accept) r.accept = 'medium';
  const counter = !r.decline && !refusedAccept && !hostile && ((CONDITION_BACK.test(s) && acceptsTerms) || SPLIT_TERMS.test(s));
  if (!r.end && !r.decline && !r.accept) {
    if (MUTUAL_NO_ATTACK.test(s)) {
      r.proposal = 'high';
      r.mutual = true;
    }
    else if (truce) r.proposal = offer ? 'high' : 'medium';
    else if (offer && !hostile && PEACE_OVERTURE.test(s)) r.proposal = 'medium';
    else if (!hostile && NO_ATTACK_PROMISE.test(s)) r.proposal = 'medium';
    else if (hasQuestion && DEAL_QUESTION.test(s)) r.proposal = 'medium';
  }
  if (counter && !r.end && !r.proposal) r.proposal = 'medium';
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
  // A negated or self-aimed gang-up asks for none ("dont gang up on me", "stop ganging up on me").
  const g = s
    .replace(/\b(dont|do not|never|wont|will not|not|stop|quit|no)( \w+)? (gang|ganging|team|teaming|dogpile|dogpiling|dog pile) up\b/g, ' ')
    .replace(/\b(dont|do not|never|wont|will not|not|stop|quit|no) (dogpile|dogpiling|dog pile)\b/g, ' ')
    .replace(/\b(gang|ganging|ganged|team|teaming|teamed) up on (me|us|myself)\b/g, ' ')
    .replace(/\b(dogpile|dogpiling|dog pile|dog piling) (on )?(me|us)\b/g, ' ');
  if (/\b(gang up|team up|dogpile|dog pile|ally against|work together against)\b/.test(g)) return 'high';
  if (/\b(ally|allies|alliance|team) with (me|us)( \w+)? against\b/.test(g)) return 'high';
  if (/\bhelp\b.*\b(vs|versus|against)\b/.test(s)) return 'high';
  // "help me attack Redcrane": an ask to join an attack on someone other than me or you.
  if (/\bhelp (me|us)( to)? (attack|hit|kill|crush|take down|take out|focus|stop) (?!me\b|us\b|you\b|myself\b)\w/.test(s)) {
    return namesPlayer || COORDINATION_TARGET.test(s) ? 'high' : 'medium';
  }
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

/** A negated attack on me promises none ("im not gonna attack you", "nobody is gonna attack you"). */
const NEGATED_THREAT =
  /\b(not|never|nobody|no one|noone|wont|will not|dont|do not|arent|aint|isnt)( (ever|really|even|going to|gonna|planning to|trying to|about to|to))* (attack|kill|wipe|destroy|crush|hit|eliminate|end|take) you\b/g;

function threat(raw: string): Strength | null {
  if (DARE_BREAK.test(raw)) return 'high';
  const s = raw.replace(NEGATED_THREAT, ' ');
  if (/\b(i will|ill|im going to|im gonna|i am going to|i am gonna)( now)? (attack|kill|wipe|destroy|crush|hit|eliminate|end|take) you\b(?! up\b)/.test(s)) return 'high';
  // "accept truce or i attack", "or well hit you": an ultimatum.
  if (/\bor (i|we|ill|well|i will|we will|im gonna|im going to)( just)? (attack|kill|wipe|destroy|crush|hit|eliminate|end|take|break)\b/.test(s)) return 'high';
  if (/\b(i will|ill|im going to|im gonna|i am going to|i am gonna) (wipe|destroy|crush|eliminate|end) you\b/.test(s)) return 'high';
  if (/\b(wipe|destroy|crush) you out\b|\bill wipe you\b/.test(s)) return 'high';
  if (/\bback off\b|\bcoming for you\b|\bor else\b|\byoull regret\b|\byou will regret\b/.test(s)) return 'high';
  if (/\b(attack|hit) me( again)? and\b.*\b(regret|sorry|pay|die|destroy|end you|war)\b/.test(s)) return 'high';
  // "we should attack you", "lets attack you": aimed at me, not a call to gang up on someone else.
  if (/\b(we will|well|we are going to|were going to|were gonna|we should|we must|we need to|lets|let us)( now| just)? (attack|kill|wipe|destroy|crush|hit|eliminate|take out|take down) you\b(?! up\b)/.test(s)) return 'high';
  if (/\b(you are|youre|you re) (dead|toast|finished)\b/.test(s)) return 'high';
  if (/\bget out of\b|\bstay out of\b|\bleave my\b/.test(s)) return 'medium';
  return null;
}

const PLEASE_ACCEPT_DEAL = new RegExp(`\\b(${TRUCE_NOUN.slice(1, -1)}|offer|terms|proposal|pact|invite|invitation)\\b`);

function surrenderAsk(s: string): Strength | null {
  if (/\baccept (my |the |our )?surrender\b|\bsurrender accept/.test(s)) return 'high';
  // "please accept the truce" asks for a truce, "please accept the deal / my offer" a deal: neither a surrender.
  if (/\bplease accept\b/.test(s) && !TRUCE_WORD.test(s) && !PLEASE_ACCEPT_DEAL.test(s)) return 'high';
  if (/\bi surrender\b|\bi m surrendering\b|\bim surrendering\b/.test(s)) return 'high';
  // "i resign" / "i concede" only of the game: at the end, or with gg ("i concede the point", "i resign from this alliance": none).
  if (/\bi (resign|concede)( (the game|this game|game|gg|ggs|ggwp|good game|wp|well played|please|accept|now|lol|i surrender))*$/.test(s)) return 'high';
  // "i give up" / "i quit" only at the end of the message or followed by gg or an ask ("i give up on you lol" is not one).
  if (/\bi (give up|quit)( (gg|ggs|ggwp|good game|wp|well played|accept|please|i surrender)\b.*)?$/.test(s)) return 'high';
  return null;
}

/** A surrender put as a question and answered no ("I surrender? never", "accept my surrender? no"). */
const SURRENDER_REFUSED = /\b(surrender|resign|concede|give up|quit)\b[^?]*\?+\s*(no|never|nope|nah|not|lol no|hell no)\b/;

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
  strengths: {},
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
    // My own name stands for "you" in a threat ("i will kill Bluefox").
    const meNames = players
      .filter((p) => p?.isMe)
      .map((p) => flatten(safeString(p.name)))
      .filter((n) => n.length >= MIN_NAME);
    let threatText = ` ${s} `;
    for (const n of meNames) threatText = threatText.split(` ${n} `).join(' you ');
    const threatStrength = threat(threatText.trim());
    const truce = truceOf(s, hasQuestion, open, threatStrength !== null);
    put('truce-proposal', truce.proposal);
    put('truce-accept', truce.accept);
    put('truce-decline', truce.decline);
    put('truce-end-notice', truce.end);
    put('coordination-ask', coordinationAsk(s, mentions.players.length > 0));
    // A mutual no-attack offer is a proposal, not a threat; a coercive one ("… if you dont accept truce") is both.
    if (!truce.mutual) put('threat', threatStrength);
    // A surrender asked then refused ("I surrender? never") asks none.
    if (!SURRENDER_REFUSED.test(raw.toLowerCase())) put('surrender-ask', surrenderAsk(s));
    put('gg', gg(s));
    put('banter', banter(s));
    // "Hey X, … i accept your terms": the opening greeting does not decide a longer message's label (#460).
    if (found.size === 0 || s.split(' ').length <= GREETING_ALONE_WORDS) put('greeting', greeting(s));
    if (found.size === 0 && hasQuestion) found.set('question-other', 'medium');

    const intents = INTENTS.filter((i) => found.has(i));
    let confidence: IntentConfidence = 'low';
    if (intents.some((i) => i !== 'question-other' && found.get(i) === 'high')) confidence = 'high';
    else if (intents.some((i) => i !== 'question-other')) confidence = 'medium';

    const strengths: Partial<Record<Intent, IntentConfidence>> = {};
    for (const i of intents) strengths[i] = i === 'question-other' ? 'low' : (found.get(i) ?? 'low');

    const meIds = new Set(players.filter((p) => p?.isMe).map((p) => p.id));
    const repliesToMe = open && (found.has('truce-accept') || found.has('truce-decline'));
    const addressedToMe = c.toMe === true || mentions.players.some((id) => meIds.has(id)) || repliesToMe;
    return { intents, confidence, strengths, addressedToMe, mentions };
  } catch {
    return EMPTY();
  }
}
