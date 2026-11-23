// War.app mods whose published source has been read, and what each changes (#165's mods warning made
// mod-aware). A mod listed here with `turnRules: false` changes no rule the planner models while turns are
// played, so a plan in a game running only such mods does not say its rules may not hold. Every other mod
// id keeps the general warning. Pure.

/** The Local Deployment Helper mod's id (game 45736172's settings: `Mods[].ModID` "336"). */
export const LOCAL_DEPLOYMENT_HELPER = 336;

export interface KnownMod {
  id: number;
  name: string;
  /** Whether it changes a rule while turns are played (combat, income, orders, cards). */
  turnRules: boolean;
  /** What it does, in our words, for a plan's warnings. */
  note: string;
}

/**
 * Read 2026-11-23 from the published source (JustMe003/WarzoneMods, `Local_Deployment_Helper` and
 * `LDHelper2`, ModVersion 3.0): it has no server turn hook (no `Server_AdvanceTurn_*`), only
 * `Server_Created` (at game creation: turns Local Deployment on, optionally "attack by percentage", and —
 * its default "bonus overrider" — sets to 0 every bonus on a territory that is in more than one non-zero
 * bonus except the one with fewest territories, so Local Deployment's pools never overlap; those values
 * reach us as the game's `OverriddenBonuses`, which the model applies), `Server_GameCustomMessage` (saves a
 * player's helper inputs) and web-client hooks: at a new turn, with the order list empty, its default
 * `AutoDeploy` adds last turn's orders and updated deploys to the client's list (only in the web client; a
 * `warapp_submit_turn` send replaces the whole list), and a marker custom order `[LDH_V3]` it removes again
 * before a commit.
 */
const MODS: KnownMod[] = [
  {
    id: LOCAL_DEPLOYMENT_HELPER,
    name: 'Local Deployment Helper',
    turnRules: false,
    note:
      'This game runs the Local Deployment Helper (mod 336), which changes no rule during a turn (its published ' +
      'source has no turn hook). At creation it turned Local Deployment on and set to 0 every bonus but the ' +
      'smallest on a territory in more than one bonus — those are the game\'s overridden bonuses, which this plan ' +
      'applies: a 0-value bonus has no deploy pool, so only the free income (the base income — MinimumArmyBonus, or ' +
      'territories ÷ BonusArmyPer when larger — and card armies) lands on its territories. In the web client it may add last ' +
      "turn's orders to an empty order list when the game is opened there; a warapp_submit_turn send replaces the " +
      'whole list. Read from its source version 3.0; a later version may differ.',
  },
];

export const KNOWN_MODS: ReadonlyMap<number, KnownMod> = new Map(MODS.map((m) => [m.id, m]));
