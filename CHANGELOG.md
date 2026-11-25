# Changelog

## [0.15.0](https://github.com/chrischall/warapp-mcp/compare/v0.14.0...v0.15.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **estimates:** a `known_income` entry given to `warapp_plan_turn` or `warapp_check_plan` without a `source` now defaults to `"board"` and no longer scales the other opponents' fog prior ([#444](https://github.com/chrischall/warapp-mcp/issues/444)). Pass `source: "chat"` for a stated income to keep that. Incomes kept by `warapp_record_intel` still count as chat. The output contract is unchanged: `stated.ratio` is still mean ÷ mine, and the new `stated.scale` holds the factor applied.

### Features

* **calibration:** log each estimate stage and score it against the truth ([#568](https://github.com/chrischall/warapp-mcp/issues/568)) ([#582](https://github.com/chrischall/warapp-mcp/issues/582)) ([845013a](https://github.com/chrischall/warapp-mcp/commit/845013aa2e19a27768ad3345fc3eab9725ae7309))
* **estimates:** let a well-read turn's low end lift the 1.3x rise cap ([#576](https://github.com/chrischall/warapp-mcp/issues/576)) ([1c82012](https://github.com/chrischall/warapp-mcp/commit/1c82012c9ab1700ff7d2936c5025db8be2fff865))
* **estimates:** only chat-stated incomes from two players rescale the other opponents ([#574](https://github.com/chrischall/warapp-mcp/issues/574)) ([8f3b1eb](https://github.com/chrischall/warapp-mcp/commit/8f3b1ebdc61ba63cf781d2fd178c8f02cf4faf62))
* **estimates:** show the uncapped observed income and when a known income rescaled others ([#572](https://github.com/chrischall/warapp-mcp/issues/572)) ([6469951](https://github.com/chrischall/warapp-mcp/commit/64699512b29e0427fb1fc6ecdd8eb4501cb6dce4))
* warapp_calibration and warapp_turn_history ([#569](https://github.com/chrischall/warapp-mcp/issues/569), [#570](https://github.com/chrischall/warapp-mcp/issues/570)) ([#571](https://github.com/chrischall/warapp-mcp/issues/571)) ([a167dba](https://github.com/chrischall/warapp-mcp/commit/a167dba262545d478945e9764d3e16c6903a2329))


### Bug Fixes

* **check-plan:** name players in the [#567](https://github.com/chrischall/warapp-mcp/issues/567) warnings by name and id ([#577](https://github.com/chrischall/warapp-mcp/issues/577)) ([2c5b887](https://github.com/chrischall/warapp-mcp/commit/2c5b88783a0a019a276fdd3b35e433bd15da4fdc))


### Documentation

* **#567:** drop the DRAFT wording now the owner has approved the rule ([#580](https://github.com/chrischall/warapp-mcp/issues/580)) ([4943e64](https://github.com/chrischall/warapp-mcp/commit/4943e642b408a4dc940db321401b4eeaefc9a0db))

## [0.14.0](https://github.com/chrischall/warapp-mcp/compare/v0.13.1...v0.14.0) (2026-11-24)


### Features

* **cards:** offer an Airlift plan beside the plain plan in warapp_plan_turn ([#557](https://github.com/chrischall/warapp-mcp/issues/557)) ([2c6b77f](https://github.com/chrischall/warapp-mcp/commit/2c6b77f5faa39a46d6f917da45d3ca988496dddf))
* **cards:** play Emergency Blockade and Blockade through the Airlift pipeline ([#561](https://github.com/chrischall/warapp-mcp/issues/561)) ([ed51344](https://github.com/chrischall/warapp-mcp/commit/ed5134409472dd9ce57df148ce1242b7b863443b))
* **cards:** play the Bomb through the Airlift pipeline ([#560](https://github.com/chrischall/warapp-mcp/issues/560)) ([815b583](https://github.com/chrischall/warapp-mcp/commit/815b5839a448c2f568f7a1b649d13c2ce883f83d))
* **cards:** show my hand, simulate Airlifts exactly and verify them after submit ([#555](https://github.com/chrischall/warapp-mcp/issues/555)) ([5c77da3](https://github.com/chrischall/warapp-mcp/commit/5c77da3c582729cd05be18decee8b9727051b05a))
* **cards:** stage an Airlift for next turn's capture in the Airlift plan ([#559](https://github.com/chrischall/warapp-mcp/issues/559)) ([577ba15](https://github.com/chrischall/warapp-mcp/commit/577ba15e881c5b94c4f5ac006b2773883d64e611))
* **output:** show times in your timezone with WARAPP_TIMEZONE ([#549](https://github.com/chrischall/warapp-mcp/issues/549)) ([05f4350](https://github.com/chrischall/warapp-mcp/commit/05f4350620309f229ef3d0348152d82d6ad3ebef))
* **relations:** per-territory caps on an active truce ([#550](https://github.com/chrischall/warapp-mcp/issues/550)) ([3a6f1f9](https://github.com/chrischall/warapp-mcp/commit/3a6f1f95a870f58e7dc64b3ec86fdc9b14e4033c))
* **relations:** record a coordinated attack with a partner (report only) ([#552](https://github.com/chrischall/warapp-mcp/issues/552)) ([727e28d](https://github.com/chrischall/warapp-mcp/commit/727e28d8431ea0e48af158dbbf780ee5550bbb67))


### Documentation

* **cards:** describe the wall plan as built and owner-approved ([#565](https://github.com/chrischall/warapp-mcp/issues/565)) ([913f4a9](https://github.com/chrischall/warapp-mcp/commit/913f4a95b3617cfc9c0e452484b33fa501598542))
* **check-plan:** add the missing space before the Sanctions sentence ([#566](https://github.com/chrischall/warapp-mcp/issues/566)) ([9dea4b7](https://github.com/chrischall/warapp-mcp/commit/9dea4b7ac5197ae1f3fcb1cb57f9c4ba9678d677))
* **relations:** keep breachWatch's doc comment above breachWatch ([#554](https://github.com/chrischall/warapp-mcp/issues/554)) ([a51077e](https://github.com/chrischall/warapp-mcp/commit/a51077e69d44f61b5e70c1c3b6a270ab1cd0447c))

## [0.13.1](https://github.com/chrischall/warapp-mcp/compare/v0.13.0...v0.13.1) (2026-11-24)


### Bug Fixes

* **end-of-game:** keep the winner's last board, mark surrender-into-AI seats, and show the stats version ([#547](https://github.com/chrischall/warapp-mcp/issues/547)) ([1d58b91](https://github.com/chrischall/warapp-mcp/commit/1d58b91a8204cc7d578c3e510fd8c3b95dd48199))

## [0.13.0](https://github.com/chrischall/warapp-mcp/compare/v0.12.1...v0.13.0) (2026-11-24)


### Features

* **outlook:** advise a coalition with the trailing players before surrendering a free-for-all ([#544](https://github.com/chrischall/warapp-mcp/issues/544)) ([16a6ac6](https://github.com/chrischall/warapp-mcp/commit/16a6ac60bb766a4566abf0682ad1a4151ea52ea0))


### Bug Fixes

* **end-of-game:** stop and resume seat lines as the client does; AI-taken seats ([#543](https://github.com/chrischall/warapp-mcp/issues/543)) ([6372900](https://github.com/chrischall/warapp-mcp/commit/6372900c16a873b5ee9854d529dbd073aeca0a1c))

## [0.12.1](https://github.com/chrischall/warapp-mcp/compare/v0.12.0...v0.12.1) (2026-11-23)


### Bug Fixes

* **get-game:** keep the raw history out of the compact view ([#538](https://github.com/chrischall/warapp-mcp/issues/538)) ([de62294](https://github.com/chrischall/warapp-mcp/commit/de62294f21a39d76d1788ac2902c2516d6f5e1de))

## [0.12.0](https://github.com/chrischall/warapp-mcp/compare/v0.11.0...v0.12.0) (2026-11-23)


### Features

* **cards:** Gift verified live; a completing gift goes into the orders ([#435](https://github.com/chrischall/warapp-mcp/issues/435)) ([#534](https://github.com/chrischall/warapp-mcp/issues/534)) ([549301e](https://github.com/chrischall/warapp-mcp/commit/549301ec345c0a0d2689a78b84608f5ce98e0b76))
* **cards:** model Sanctions on every income and a card clock that resets on seen plays ([#516](https://github.com/chrischall/warapp-mcp/issues/516)) ([27ab81a](https://github.com/chrischall/warapp-mcp/commit/27ab81addbe5400055403ffe12da06f3e0c8f2ac))
* **commander:** keep a one-territory commander safe against fogged neighbours ([#529](https://github.com/chrischall/warapp-mcp/issues/529)) ([2568f11](https://github.com/chrischall/warapp-mcp/commit/2568f11b35eb2ba1f91954b041772f0ade7d1963))
* **deploy:** Local Deployment limits for zero-value bonuses and the helper mod ([#527](https://github.com/chrischall/warapp-mcp/issues/527)) ([9d2dbae](https://github.com/chrischall/warapp-mcp/commit/9d2dbae678428be41a6cb681eeca8b3f125e33b7))
* **end-of-game:** per-player stats and closing out a finished game ([#528](https://github.com/chrischall/warapp-mcp/issues/528)) ([55edbee](https://github.com/chrischall/warapp-mcp/commit/55edbeeb2231ab6d434b39fa07991deaab729daa))
* **picks:** rank single-pick starts on huge maps ([#525](https://github.com/chrischall/warapp-mcp/issues/525)) ([113fcb9](https://github.com/chrischall/warapp-mcp/commit/113fcb9d151eb3770a3cc9847c0bb85f4015f41c))
* **relations:** Diplomacy 2 mod alliances as enforced truces ([#524](https://github.com/chrischall/warapp-mcp/issues/524)) ([7af7953](https://github.com/chrischall/warapp-mcp/commit/7af79536e4a8cb75936689893a30e248b7bb385f))
* **scale:** ~100-opponent games, mention-aware chat and boot-time pace ([#530](https://github.com/chrischall/warapp-mcp/issues/530)) ([7d8ca32](https://github.com/chrischall/warapp-mcp/commit/7d8ca326c6d6fe7379864f23deb00e18acbe867c))


### Bug Fixes

* address auto-review follow-ups for [#529](https://github.com/chrischall/warapp-mcp/issues/529) and [#530](https://github.com/chrischall/warapp-mcp/issues/530) ([#535](https://github.com/chrischall/warapp-mcp/issues/535)) ([219af5e](https://github.com/chrischall/warapp-mcp/commit/219af5eb805c8d79993044e36ef8561ed20848ce))
* **bonuses:** use the game's overridden bonus values and minimum army bonus everywhere ([#518](https://github.com/chrischall/warapp-mcp/issues/518)) ([89a78ca](https://github.com/chrischall/warapp-mcp/commit/89a78ca906716fdea473595f36484ba09c1c4af3))
* **cards:** value opponents' progressive Reinforcement cards correctly and drop a stale Sanctions warning ([#521](https://github.com/chrischall/warapp-mcp/issues/521)) ([9173722](https://github.com/chrischall/warapp-mcp/commit/917372294c904779fb29741edee91d3ff0b38537))
* **commander:** count only likely starts as fogged attackers ([#533](https://github.com/chrischall/warapp-mcp/issues/533)) ([62fe11e](https://github.com/chrischall/warapp-mcp/commit/62fe11e5f90fb1d5744af6cd7480c543e6448720))
* **outlook:** use calibrated income for fogged leaders in howLost and the surrender check ([#537](https://github.com/chrischall/warapp-mcp/issues/537)) ([d30d2c9](https://github.com/chrischall/warapp-mcp/commit/d30d2c9a7e46fa2dc322bcf08d751d736a271100))


### Documentation

* **end-of-game:** warapp_close_finished_game verified live ([#536](https://github.com/chrischall/warapp-mcp/issues/536)) ([e7aa390](https://github.com/chrischall/warapp-mcp/commit/e7aa39073d059b46216457618ef3fee57b44e3d6))

## [0.11.0](https://github.com/chrischall/warapp-mcp/compare/v0.10.0...v0.11.0) (2026-11-23)


### Features

* **chat:** territory and bonus links in chat ([#514](https://github.com/chrischall/warapp-mcp/issues/514)) ([e031143](https://github.com/chrischall/warapp-mcp/commit/e031143e8f9a5886e30fe52ee63c0da46c62c7a9))
* **relations:** partner-approved truce exceptions that are not breaks ([#512](https://github.com/chrischall/warapp-mcp/issues/512)) ([863804f](https://github.com/chrischall/warapp-mcp/commit/863804f0349391a748fae480f69b61a5b6ab9b2d))


### Bug Fixes

* **chat:** never mark a game seen that the inbox filter leaves out ([#515](https://github.com/chrischall/warapp-mcp/issues/515)) ([2abf9b2](https://github.com/chrischall/warapp-mcp/commit/2abf9b2796fafa57bd56d6da5bcee29b4b7628df))

## [0.10.0](https://github.com/chrischall/warapp-mcp/compare/v0.9.0...v0.10.0) (2026-11-23)


### Features

* **calibrate:** split the opening benchmark by era, with medians and missed turns apart ([#507](https://github.com/chrischall/warapp-mcp/issues/507)) ([6e4542f](https://github.com/chrischall/warapp-mcp/commit/6e4542fdc92fa3e2245f4a7afeb0a928f0dcb816))
* **chat:** unread chat in the game list and inbox, one-step mark read ([#510](https://github.com/chrischall/warapp-mcp/issues/510)) ([69f5ef6](https://github.com/chrischall/warapp-mcp/commit/69f5ef676126e0fc0cce01bb1dfbf14c37c28137))
* **turn:** warn when the orders delay the nearest bonus ([#508](https://github.com/chrischall/warapp-mcp/issues/508)) ([9ffcabf](https://github.com/chrischall/warapp-mcp/commit/9ffcabf4c29c7d8692ee955d260f2a84696e731a))

## [0.9.0](https://github.com/chrischall/warapp-mcp/compare/v0.8.0...v0.9.0) (2026-11-23)


### Features

* **cards:** read opponents' unfogged Reinforcement plays from the history ([#427](https://github.com/chrischall/warapp-mcp/issues/427)) ([#499](https://github.com/chrischall/warapp-mcp/issues/499)) ([0091646](https://github.com/chrischall/warapp-mcp/commit/009164661b84fc85f4728a3b45b8cf673edfbd36))
* **planner:** the nearest bonus's steps are funded first while [#319](https://github.com/chrischall/warapp-mcp/issues/319) fires ([#416](https://github.com/chrischall/warapp-mcp/issues/416)) ([#502](https://github.com/chrischall/warapp-mcp/issues/502)) ([81fdcc8](https://github.com/chrischall/warapp-mcp/commit/81fdcc88b7a6298937aae71ed8189a4d783ad984))
* **turn:** read back my committed orders (warapp_get_my_orders) ([#501](https://github.com/chrischall/warapp-mcp/issues/501)) ([698acd0](https://github.com/chrischall/warapp-mcp/commit/698acd005b96b04741718298ec12a63f4b09a14b))


### Bug Fixes

* **teams:** verify teammate order and pick reads live ([#435](https://github.com/chrischall/warapp-mcp/issues/435)) ([#498](https://github.com/chrischall/warapp-mcp/issues/498)) ([0793336](https://github.com/chrischall/warapp-mcp/commit/0793336fae469a03c70bbc6023c6287e68a1a30f))

## [0.8.0](https://github.com/chrischall/warapp-mcp/compare/v0.7.0...v0.8.0) (2026-11-23)


### Features

* **cards:** count an opponent's Reinforcement card once and run its clock at the expected rate ([#427](https://github.com/chrischall/warapp-mcp/issues/427)) ([#491](https://github.com/chrischall/warapp-mcp/issues/491)) ([e84520b](https://github.com/chrischall/warapp-mcp/commit/e84520b75adabe243e3e6b97fb06cdc752c56204))
* **join:** the joining policy is a refusal, with the handicap rules added ([#423](https://github.com/chrischall/warapp-mcp/issues/423)) ([#471](https://github.com/chrischall/warapp-mcp/issues/471)) ([c1760d0](https://github.com/chrischall/warapp-mcp/commit/c1760d0e1216a8a8d4a66f350e9fa9b0c7498524))
* **join:** warn before joining a tournament game ([#423](https://github.com/chrischall/warapp-mcp/issues/423)) ([#481](https://github.com/chrischall/warapp-mcp/issues/481)) ([59558ad](https://github.com/chrischall/warapp-mcp/commit/59558adbf3dc8eed3538375150df87fd7fff6001))
* **outlook:** advise a coalition against the leader before the surrender line ([#445](https://github.com/chrischall/warapp-mcp/issues/445)) ([#473](https://github.com/chrischall/warapp-mcp/issues/473)) ([8101535](https://github.com/chrischall/warapp-mcp/commit/8101535ff52521439d7a83171f132f595be0f3b4))
* **picks:** replace a 1v1 primary pick that only pays beside the pick above it ([#429](https://github.com/chrischall/warapp-mcp/issues/429)) ([#487](https://github.com/chrischall/warapp-mcp/issues/487)) ([9a8f29c](https://github.com/chrischall/warapp-mcp/commit/9a8f29cf78d786953d16dd3dd76d14ef56d45ba5))
* **planner:** a doomed conceded stack attacks out or merges instead of standing ([#431](https://github.com/chrischall/warapp-mcp/issues/431)) ([#490](https://github.com/chrischall/warapp-mcp/issues/490)) ([c111426](https://github.com/chrischall/warapp-mcp/commit/c111426898bfdc644270751e574d7f31cf52f87d))
* **planner:** a lone foothold carries its building share, not the whole bonus ([#425](https://github.com/chrischall/warapp-mcp/issues/425)) ([#483](https://github.com/chrischall/warapp-mcp/issues/483)) ([c1a0ca1](https://github.com/chrischall/warapp-mcp/commit/c1a0ca14d9e0ebbaa064578a34ae34463bbb477d))
* **planner:** complete a bonus that repays its losses in one turn ([#422](https://github.com/chrischall/warapp-mcp/issues/422)) ([#486](https://github.com/chrischall/warapp-mcp/issues/486)) ([288bc65](https://github.com/chrischall/warapp-mcp/commit/288bc65fcaaca6ed4770c4ec76e9c5f4772764a9))
* **planner:** count only the income Local Deployment lets reach the gates in the 1v1 gate budget ([#433](https://github.com/chrischall/warapp-mcp/issues/433)) ([#493](https://github.com/chrischall/warapp-mcp/issues/493)) ([7daf87c](https://github.com/chrischall/warapp-mcp/commit/7daf87c6556335dae69c29d2e1bf9e3754e08ad6))
* **planner:** finish the nearest bonus first: count armies beside it, ignore +1 bonuses ([#416](https://github.com/chrischall/warapp-mcp/issues/416)) ([#484](https://github.com/chrischall/warapp-mcp/issues/484)) ([ef4805e](https://github.com/chrischall/warapp-mcp/commit/ef4805ed13418cf38a071956d22a1330d5e06259))
* **planner:** retake a lost held-bonus member in every format ([#430](https://github.com/chrischall/warapp-mcp/issues/430)) ([#488](https://github.com/chrischall/warapp-mcp/issues/488)) ([2366430](https://github.com/chrischall/warapp-mcp/commit/2366430b684d8b58a712c84df080cafcc101e576))
* **planner:** shorter capture payback and no wastelands while a 1v1's gates are short ([#432](https://github.com/chrischall/warapp-mcp/issues/432)) ([#489](https://github.com/chrischall/warapp-mcp/issues/489)) ([4ed1d2f](https://github.com/chrischall/warapp-mcp/commit/4ed1d2fec6e60f7c6124a6ef107170ac39506bca))
* **planner:** take free no-loss neutral captures and warn about idle stacks beside them ([#426](https://github.com/chrischall/warapp-mcp/issues/426)) ([#485](https://github.com/chrischall/warapp-mcp/issues/485)) ([f86b54c](https://github.com/chrischall/warapp-mcp/commit/f86b54c2fd6ce626922cad481cce314c275ea5d4))
* **teams:** the nearer teammate works a shared bonus when Gift is in play; team-game fixes ([#435](https://github.com/chrischall/warapp-mcp/issues/435)) ([#492](https://github.com/chrischall/warapp-mcp/issues/492)) ([7dfda54](https://github.com/chrischall/warapp-mcp/commit/7dfda541adca070db8f799f92eb56ca6e665c3c8))


### Bug Fixes

* **picks:** document the team-game teammate-list refusal; sweep auto-review follow-ups ([#496](https://github.com/chrischall/warapp-mcp/issues/496)) ([9bb203d](https://github.com/chrischall/warapp-mcp/commit/9bb203d0a29c3f1ef3172eca47a6f45b0435d436))
* **picks:** rank a very large map from its best bonuses, with a time budget and a bounded compact view ([#474](https://github.com/chrischall/warapp-mcp/issues/474)) ([85f1bcf](https://github.com/chrischall/warapp-mcp/commit/85f1bcf756345b4a44b4683579d3cabd1b41deaf))
* **picks:** rank by score alone when every territory is dealt ([#476](https://github.com/chrischall/warapp-mcp/issues/476)) ([#494](https://github.com/chrischall/warapp-mcp/issues/494)) ([dd4eb85](https://github.com/chrischall/warapp-mcp/commit/dd4eb857529ca2d4c405be1d60c857203f22e174))
* **picks:** rank very large maps by each territory's own opening, within the budget ([#476](https://github.com/chrischall/warapp-mcp/issues/476)) ([#482](https://github.com/chrischall/warapp-mcp/issues/482)) ([18116fc](https://github.com/chrischall/warapp-mcp/commit/18116fc15ff089c18185ad703e20eaeeb82bcb2b))
* **planner:** idle stacks walk up behind conceded borders when no front is reachable ([#497](https://github.com/chrischall/warapp-mcp/issues/497)) ([ee12355](https://github.com/chrischall/warapp-mcp/commit/ee123554f2da868a10bdb681d870983759be8dff))


### Refactor

* one gameBaseIncome accessor; GOLDEN_DUMP for reviewing golden updates ([#433](https://github.com/chrischall/warapp-mcp/issues/433)) ([#466](https://github.com/chrischall/warapp-mcp/issues/466)) ([33d57e9](https://github.com/chrischall/warapp-mcp/commit/33d57e9121a6921de6522cfdfcc80e1bde47c83f))
* split the deploy-estimate and income helpers out of plan/shared.ts ([#469](https://github.com/chrischall/warapp-mcp/issues/469)) ([d1ce252](https://github.com/chrischall/warapp-mcp/commit/d1ce252ecd54b1ae14481faa000c3589b653269f))
* split the opponent-observation block out of plan/shared.ts ([#467](https://github.com/chrischall/warapp-mcp/issues/467)) ([971ab6c](https://github.com/chrischall/warapp-mcp/commit/971ab6cb88095f5acb71f3cb69570238c14c7d98))
* split withdrawals out of plan/holds.ts and the strike stack out of plan/strike.ts ([#470](https://github.com/chrischall/warapp-mcp/issues/470)) ([12a2f0d](https://github.com/chrischall/warapp-mcp/commit/12a2f0d4c491e32db77bb426790de8f67a745551))


### Documentation

* Reconnaissance is accepted live ([#463](https://github.com/chrischall/warapp-mcp/issues/463)) ([#464](https://github.com/chrischall/warapp-mcp/issues/464)) ([336be79](https://github.com/chrischall/warapp-mcp/commit/336be792b3bef260ba54b84c7c996d167f03add6))

## [0.7.0](https://github.com/chrischall/warapp-mcp/compare/v0.6.0...v0.7.0) (2026-11-20)


### Features

* **cards:** mark the Reconnaissance play verified live, so an advised play goes into the plan's orders ([#443](https://github.com/chrischall/warapp-mcp/issues/443)) ([#462](https://github.com/chrischall/warapp-mcp/issues/462)) ([901a3e4](https://github.com/chrischall/warapp-mcp/commit/901a3e4f921fb17235df41be4f1cc4c9148df519))
* **chat:** classify other players' chat, advise a reply, show it to the model, and gate automated replies and turn blocks (both off) ([#447](https://github.com/chrischall/warapp-mcp/issues/447)) ([e46ff34](https://github.com/chrischall/warapp-mcp/commit/e46ff34ea62fbf9c065d71407b5a1f1075e8b8c2))
* **decisions:** log every turn's view, decision and outcome with end-of-game truth, and replay it offline ([#413](https://github.com/chrischall/warapp-mcp/issues/413)) ([d5e0c3a](https://github.com/chrischall/warapp-mcp/commit/d5e0c3aceedc0a3f6f74185316892c219db40dc4))
* **decisions:** log timing, checks, cards, seat events, joins and picks, tag game kinds, and export games for review ([#446](https://github.com/chrischall/warapp-mcp/issues/446)) ([5e97507](https://github.com/chrischall/warapp-mcp/commit/5e97507ec7c67787d5014b80a4feb06e6b2774f1))
* **planner:** race for vacated land with a breach force, size one full-deploy border per opponent, cap holds, and spend a stockpile ([#455](https://github.com/chrischall/warapp-mcp/issues/455)) ([7d968e1](https://github.com/chrischall/warapp-mcp/commit/7d968e178bd6740f17a693780e434d9ea3a67435))
* **planner:** race for vacated land, stop the fog ratchet while leading, rank prior-only holds after captures, and spend a stockpile ([#450](https://github.com/chrischall/warapp-mcp/issues/450)) ([35562e4](https://github.com/chrischall/warapp-mcp/commit/35562e4a931ba36d5a0b8f8d8ff6259f3df6d2c7))
* **planner:** raise estimates from proof and lower them gradually, cap the fog at the map winners' pace, and a clearer outlook with surrender-line advice ([#453](https://github.com/chrischall/warapp-mcp/issues/453)) ([8739262](https://github.com/chrischall/warapp-mcp/commit/87392622f39beada351b4a33e64d75da4ab38acc))
* **planner:** value cities by income per army, stage toward them, guard the top earner, and sharper chat, card and since-last advice ([#448](https://github.com/chrischall/warapp-mcp/issues/448)) ([cb51650](https://github.com/chrischall/warapp-mcp/commit/cb51650d26e71cbea62b1a54f37ae96e3d2d6c17))


### Bug Fixes

* **cards:** Blockade and Airlift advice, spy plays once verified, commander armies in finished records, and read a counter-offer as a truce reply ([#461](https://github.com/chrischall/warapp-mcp/issues/461)) ([8fbbd98](https://github.com/chrischall/warapp-mcp/commit/8fbbd98531fba77b21e19a56fc1e44f8980d2f61))
* **planner:** keep off a truce partner's neutrals, no Bomb advice on a player at peace, and keep the outlook state contract ([#458](https://github.com/chrischall/warapp-mcp/issues/458)) ([31a3860](https://github.com/chrischall/warapp-mcp/commit/31a386049136fd2cede97433d120d36137d256f2))
* **planner:** read DistributionMode -1 as a limited start, full distribution without a limit, and price fogged members from what is known ([#451](https://github.com/chrischall/warapp-mcp/issues/451)) ([e44099f](https://github.com/chrischall/warapp-mcp/commit/e44099f51ad1277cd3c7e2cbb2a65faaa9e798a8))

## [0.6.0](https://github.com/chrischall/warapp-mcp/compare/v0.5.0...v0.6.0) (2026-11-20)


### Features

* **advisor:** picks fallback ranking, headroom table ranking, opening spread warning, and jab and top-up profile habits ([#403](https://github.com/chrischall/warapp-mcp/issues/403)) ([fb29b88](https://github.com/chrischall/warapp-mcp/commit/fb29b88629811967855ac977a371cb19e6ca7651))
* **cards:** advise when to play my own Emergency Blockade, and record Diplomacy as verified live ([#371](https://github.com/chrischall/warapp-mcp/issues/371)) ([bb71462](https://github.com/chrischall/warapp-mcp/commit/bb71462697c1eb31ceebe28d6e8c925d22ff40cc))
* **commerce:** buy cities with warapp_submit_turn, and say where a city pays back ([#356](https://github.com/chrischall/warapp-mcp/issues/356)) ([76efefb](https://github.com/chrischall/warapp-mcp/commit/76efefbd37e4f4e43374a7f274046c7a860d6b8e))
* **commerce:** plan Commerce games with your gold, the game's army price and the cities on the board ([#353](https://github.com/chrischall/warapp-mcp/issues/353)) ([bd83afb](https://github.com/chrischall/warapp-mcp/commit/bd83afb2ddca894c2864e805994de338f76821ca))
* **planner:** a siege goal that breaks an opponent's cheapest bonuses and holds the assault until he is weakened ([#384](https://github.com/chrischall/warapp-mcp/issues/384)) ([12b8a52](https://github.com/chrischall/warapp-mcp/commit/12b8a528a8dc8d1aafe69eb7cfaf745885f4495b))
* **planner:** avoid_territories and avoid_players on plan_turn and check_plan ([#381](https://github.com/chrischall/warapp-mcp/issues/381)) ([9abbbfa](https://github.com/chrischall/warapp-mcp/commit/9abbbfab410fdcb3955f2fce8938870878d44ebc))
* **planner:** credit a gate for what its loss opens, and keep the gate behind a conceded border ([#357](https://github.com/chrischall/warapp-mcp/issues/357)) ([5b3390b](https://github.com/chrischall/warapp-mcp/commit/5b3390b088b5adbc40139b0cf453b7da157ddacf))
* **planner:** infer who moved first from my own first-order capture ([#377](https://github.com/chrischall/warapp-mcp/issues/377)) ([c9452a2](https://github.com/chrischall/warapp-mcp/commit/c9452a249b9414f5b60c8bd322fb2240c9966dd9))
* **planner:** report my income trend, and save toward a reachable bonus when it is flat ([#360](https://github.com/chrischall/warapp-mcp/issues/360)) ([8696346](https://github.com/chrischall/warapp-mcp/commit/869634666599516ef1ceb9d22bdcff576d3bd957))
* **planner:** report the 1v1 gate budget, and stop opening a gate the income cannot hold ([#358](https://github.com/chrischall/warapp-mcp/issues/358)) ([b8a5f52](https://github.com/chrischall/warapp-mcp/commit/b8a5f526e98432e89fc3d36b90550b66fc20c22d))
* **planner:** siege memory across turns: start income, turns, income trend and re-broken bonuses ([#389](https://github.com/chrischall/warapp-mcp/issues/389)) ([40bbebb](https://github.com/chrischall/warapp-mcp/commit/40bbebb5c870fc79c845decf29f3a3ec7246b664))
* **planner:** single-army jabs at 0% luck and straight rounding, on under a siege ([#397](https://github.com/chrischall/warapp-mcp/issues/397)) ([5bc0f3f](https://github.com/chrischall/warapp-mcp/commit/5bc0f3f4fc0e60a0344255a23ef71b80da369845))
* **planner:** the profile picks the siege whenever bonus attrition fits ([#399](https://github.com/chrischall/warapp-mcp/issues/399)) ([99a7d61](https://github.com/chrischall/warapp-mcp/commit/99a7d61ecff82141402fe603d887c935cf05cbd9))
* **relations:** remember avoid targets and stated incomes so every plan applies them ([#392](https://github.com/chrischall/warapp-mcp/issues/392)) ([379f954](https://github.com/chrischall/warapp-mcp/commit/379f954dac7b0797b770de7e7626c8a0b867e30b))
* **state:** export local history and import it into the hosted server, and backfill finished games faster ([#409](https://github.com/chrischall/warapp-mcp/issues/409)) ([30f0927](https://github.com/chrischall/warapp-mcp/commit/30f09276c940374e8975caf6ce7a5b74cfe3f5b3))


### Bug Fixes

* **cards:** count a team's hand against the team's limit as war.app does (V8) ([#401](https://github.com/chrischall/warapp-mcp/issues/401)) ([a7bcb13](https://github.com/chrischall/warapp-mcp/commit/a7bcb1320ea50fea8a4a0e30981355b1061b4be5))
* **chat:** read the team and private messages GameRefresh leaves out ([#395](https://github.com/chrischall/warapp-mcp/issues/395)) ([acc4ae4](https://github.com/chrischall/warapp-mcp/commit/acc4ae47f78b3a478d9feec576ecf546f6e61b7e))
* **chat:** send chat with the 'seen nothing' markers war.app expects, so warapp_send_chat is no longer refused ([#362](https://github.com/chrischall/warapp-mcp/issues/362)) ([32115ca](https://github.com/chrischall/warapp-mcp/commit/32115cab023f0e0cb80a1ccdf83c2d5b5e1892b0))
* **check-plan:** rank truce-breaking replies and exposures after the real threats ([#379](https://github.com/chrischall/warapp-mcp/issues/379)) ([b71d9c0](https://github.com/chrischall/warapp-mcp/commit/b71d9c08bf4c75bd0ff3db0473eb35adf64657a9))
* **check-plan:** report the income left after Sanctions on me ([#380](https://github.com/chrischall/warapp-mcp/issues/380)) ([1a9eec2](https://github.com/chrischall/warapp-mcp/commit/1a9eec2ed1b0d3d4cd4a6399045457a575c1e31f))
* **deps:** bump @chrischall/mcp-utils from 3.8.1 to 3.9.0 in the production-dependencies group ([#365](https://github.com/chrischall/warapp-mcp/issues/365)) ([1bba571](https://github.com/chrischall/warapp-mcp/commit/1bba5717169beb5efde57cb2484e8f25237b4dff))
* **deps:** bump undici from 7.30.2 to 8.12.4 in the production-majors group ([#366](https://github.com/chrischall/warapp-mcp/issues/366)) ([045ed23](https://github.com/chrischall/warapp-mcp/commit/045ed23c279d7625e7faca593261a9933c4ed822))
* **planner:** a border kept for a bonus completed this turn keeps its garrison ([#388](https://github.com/chrischall/warapp-mcp/issues/388)) ([82cfa76](https://github.com/chrischall/warapp-mcp/commit/82cfa762773504c32cbdd70f51cec21e4f023193))
* **planner:** capture the one stack a held bonus faces when that costs less than holding against it ([#394](https://github.com/chrischall/warapp-mcp/issues/394)) ([5f45ab1](https://github.com/chrischall/warapp-mcp/commit/5f45ab1357a950c2f6cff196b4fc1de5b011c474))
* **planner:** fund a held bonus before a second attack sized for the same deploy ([#396](https://github.com/chrischall/warapp-mcp/issues/396)) ([1da7687](https://github.com/chrischall/warapp-mcp/commit/1da7687c9d5f3adaca607c24d82b19dbd0db1047))
* **planner:** fund borders beside a grown enemy stack before the leftover spread ([#383](https://github.com/chrischall/warapp-mcp/issues/383)) ([c5354e7](https://github.com/chrischall/warapp-mcp/commit/c5354e770d0a104ac3b4f2cf34332c1c1940feb2))
* **planner:** garrison the members of my bonus an enemy stack roaming inside it can reach ([#391](https://github.com/chrischall/warapp-mcp/issues/391)) ([b0cbd66](https://github.com/chrischall/warapp-mcp/commit/b0cbd660d008656e24d56e7a344066c0ac112db3))
* **planner:** move idle stacks steadily toward the front instead of back and forth between turns ([#370](https://github.com/chrischall/warapp-mcp/issues/370)) ([20de450](https://github.com/chrischall/warapp-mcp/commit/20de450bf98d8379864b0bab9e90d1b00a1e8e07))
* **planner:** name the siege goal in its own warning, and warn when siege_target is given without it ([#398](https://github.com/chrischall/warapp-mcp/issues/398)) ([2368509](https://github.com/chrischall/warapp-mcp/commit/2368509bb221d6386451e57d9af3bdbf5ae9de36))
* **planner:** push a contested bonus all-in once after two failed completions, else drop it for three turns ([#405](https://github.com/chrischall/warapp-mcp/issues/405)) ([7969d95](https://github.com/chrischall/warapp-mcp/commit/7969d9561a2743884c2dfcdb2b7a55dc398944cd))
* **planner:** push or drop a bonus only while another player still holds one of its missing members ([#408](https://github.com/chrischall/warapp-mcp/issues/408)) ([0ca92e4](https://github.com/chrischall/warapp-mcp/commit/0ca92e409e52ddefe87e56d326aa2ff8e9ba71f1))
* **planner:** send the leftover with the captures when its stack has nothing left to attack, and document the auto-picked siege ([#402](https://github.com/chrischall/warapp-mcp/issues/402)) ([4b50712](https://github.com/chrischall/warapp-mcp/commit/4b507126e329fbf6ed0163dfd196301c6c8ab07d))
* **planner:** size the leftover that rides a capture to its next step, and offer the rest to another capture first ([#407](https://github.com/chrischall/warapp-mcp/issues/407)) ([0b25755](https://github.com/chrischall/warapp-mcp/commit/0b2575528f322b3edc0db5e4644efe82c7d65c60))
* **planner:** stop underestimating opponents under fog, keep the fog prior after a boot, and accept a known income ([#372](https://github.com/chrischall/warapp-mcp/issues/372)) ([896046b](https://github.com/chrischall/warapp-mcp/commit/896046b53c5401d6487b089e8f2194189cf7b326))
* **planner:** warn when a held stack survives only by a handful ([#378](https://github.com/chrischall/warapp-mcp/issues/378)) ([dfcb97d](https://github.com/chrischall/warapp-mcp/commit/dfcb97d41482b18157c3f82a1a5c18ac7b35bb15))
* **profile:** read the standing as behind in a 1v1 when the opponent's armies in view are 1.25x mine ([#404](https://github.com/chrischall/warapp-mcp/issues/404)) ([efbbba7](https://github.com/chrischall/warapp-mcp/commit/efbbba78718a8ce99947ee1b5a7ef0ad77ddc51e))
* **state:** carry an active game's contested-bonus attempt memory in the state export ([#411](https://github.com/chrischall/warapp-mcp/issues/411)) ([e437b42](https://github.com/chrischall/warapp-mcp/commit/e437b424eb7ad570a168e94b520e87a70a08a98a))


### Documentation

* put the [#368](https://github.com/chrischall/warapp-mcp/issues/368) doc comments back on the declarations they describe ([#374](https://github.com/chrischall/warapp-mcp/issues/374)) ([13896b4](https://github.com/chrischall/warapp-mcp/commit/13896b44c1d6c659eeb0fc6f033104e7c3929850))

## [0.5.0](https://github.com/chrischall/warapp-mcp/compare/v0.4.0...v0.5.0) (2026-11-17)


### Features

* **protocol:** speak war.app's current client protocol (243) and read every client build's renamed internals ([#347](https://github.com/chrischall/warapp-mcp/issues/347)) ([4414516](https://github.com/chrischall/warapp-mcp/commit/4414516a6e5b653c70c2eabcdc9e5b3f65c52616))


### Bug Fixes

* **chat:** the inbox reads recently finished games whose only chat is GameFeed's, and its entries name the game as warapp_get_chat does ([#352](https://github.com/chrischall/warapp-mcp/issues/352)) ([69d0d20](https://github.com/chrischall/warapp-mcp/commit/69d0d200b762578888c36b2e688a4ad967ab2166))
* **my-games:** stop reporting lobbies and games you are out of as unreadable pending surrenders ([#350](https://github.com/chrischall/warapp-mcp/issues/350)) ([0a4c3d8](https://github.com/chrischall/warapp-mcp/commit/0a4c3d86599d786a0294bebd3f771246714c03b6))
* **protocol:** say plainly when war.app retires the protocol this server speaks (error 48) ([#349](https://github.com/chrischall/warapp-mcp/issues/349)) ([e7a2f8e](https://github.com/chrischall/warapp-mcp/commit/e7a2f8e826e778b85c9a996e0db6e70a682eb0fa))


### Documentation

* how war.app ships new clients, how long it accepts old ones, and how to update ([#345](https://github.com/chrischall/warapp-mcp/issues/345)) ([cff04d8](https://github.com/chrischall/warapp-mcp/commit/cff04d8bbad91d1a9d0875f8150d0418f8ea0bc0))

## [0.4.0](https://github.com/chrischall/warapp-mcp/compare/v0.3.1...v0.4.0) (2026-11-17)


### Features

* **protocol:** fall back to the last client build that worked when war.app ships one this server can't read ([#344](https://github.com/chrischall/warapp-mcp/issues/344)) ([b7c3199](https://github.com/chrischall/warapp-mcp/commit/b7c3199adf0371ca2345f3d11dae45f9b731a8f2))


### Bug Fixes

* **hosted:** confirm a war.app sign-out before dropping the session, and retry it after a backoff ([#342](https://github.com/chrischall/warapp-mcp/issues/342)) ([cd1a1b6](https://github.com/chrischall/warapp-mcp/commit/cd1a1b6c8200f704d63f63a70e518126874ecc80))
* **protocol:** keep decoding boards when war.app ships a client this server cannot read ([#341](https://github.com/chrischall/warapp-mcp/issues/341)) ([59d0b3f](https://github.com/chrischall/warapp-mcp/commit/59d0b3fb64ab071424bd92a7eaa8fbdd75829d9e))

## [0.3.1](https://github.com/chrischall/warapp-mcp/compare/v0.3.0...v0.3.1) (2026-11-16)


### Bug Fixes

* **hosted:** send the war.app sign-in and the direct leg through mcp-host's egress proxy ([#338](https://github.com/chrischall/warapp-mcp/issues/338)) ([fc28e89](https://github.com/chrischall/warapp-mcp/commit/fc28e890a9fcff0467c886a48c457ebcb1fd2143))

## [0.3.0](https://github.com/chrischall/warapp-mcp/compare/v0.2.0...v0.3.0) (2026-11-16)


### Features

* **hosted:** sign in to war.app once with the password and run the hosted connector without the browser bridge ([#334](https://github.com/chrischall/warapp-mcp/issues/334)) ([0fe525d](https://github.com/chrischall/warapp-mcp/commit/0fe525d64cb7b72d6dd0c47acf181aa7aa719ae1))


### Bug Fixes

* **hosted:** keep the session status linked field a boolean and say who linked it in linkedBy ([#337](https://github.com/chrischall/warapp-mcp/issues/337)) ([f488aae](https://github.com/chrischall/warapp-mcp/commit/f488aaea639c9d14ec34847342b7867d5883c650))

## [0.2.0](https://github.com/chrischall/warapp-mcp/compare/v0.1.0...v0.2.0) (2026-11-16)


### Features

* **map:** read each distribution mode's territories from war.app's map details, and use them as the start candidates of an automatically dealt game ([#330](https://github.com/chrischall/warapp-mcp/issues/330)) ([6f1785b](https://github.com/chrischall/warapp-mcp/commit/6f1785b31c29859c1e6fdeed8441cb6aaf4804af))
* **notifications:** list, acknowledge and delete war.app's in-app notifications, mark a game's chat read on war.app, and read finished games' chat in the inbox ([#320](https://github.com/chrischall/warapp-mcp/issues/320)) ([b0878db](https://github.com/chrischall/warapp-mcp/commit/b0878db9acf6990196922c2f606eb130d49feeca))
* **profiles:** capture and process every finished game once — history, outcome, incomes, per-map record and lessons — and add a local calibration harness ([#329](https://github.com/chrischall/warapp-mcp/issues/329)) ([72b72a3](https://github.com/chrischall/warapp-mcp/commit/72b72a34c10559c08ff98c4e07dfe443afc1ef71))
* **skill:** the lessons from the lost 1v1s in the skill and strategy notes, an arrived army as the guard, and Airlift and Blockade verified live ([#307](https://github.com/chrischall/warapp-mcp/issues/307)) ([cdb1d56](https://github.com/chrischall/warapp-mcp/commit/cdb1d5679b67560dad94d45a2a6b0204b1ca4313))
* **surrender:** see a pending surrender, say when it waits on me, and accept it with warapp_accept_surrender ([#325](https://github.com/chrischall/warapp-mcp/issues/325)) ([6c478a2](https://github.com/chrischall/warapp-mcp/commit/6c478a21a28dd866cd297070dd96865a5066bb46))


### Bug Fixes

* **chat:** keep the chat source field to web or gamefeed, report a partly sent delete truthfully, and mark the notification and chat read calls verified live ([#324](https://github.com/chrischall/warapp-mcp/issues/324)) ([9ef74fa](https://github.com/chrischall/warapp-mcp/commit/9ef74fa37641cfd599fbe7d4c8f0a83e379386cc))
* **locate:** name the distribution mode the start candidates came from, and mark the map details decode verified live ([#331](https://github.com/chrischall/warapp-mcp/issues/331)) ([9168c62](https://github.com/chrischall/warapp-mcp/commit/9168c62cb647b043c36e47f3fca7c62b4b6af320))
* **planner:** say how much of an opponent's frontier its income was read from, show the outlook's evidence, and size Local Deployment borders on what can land there ([#316](https://github.com/chrischall/warapp-mcp/issues/316)) ([0b572c5](https://github.com/chrischall/warapp-mcp/commit/0b572c5586965c6bef75852df768847d368f5763))
* **strategy:** read the game's phase from the live board so contact and late notes are served, and say why a finished game's history does not read ([#315](https://github.com/chrischall/warapp-mcp/issues/315)) ([b61fd8a](https://github.com/chrischall/warapp-mcp/commit/b61fd8a52321918813ec516f2dd83d853d5f4644))

## 0.1.0 (2026-11-16)


### Features

* **cache:** keep maps and each planned game's settings on disk, so cached boards replay offline ([#233](https://github.com/chrischall/warapp-mcp/issues/233)) ([6d23c43](https://github.com/chrischall/warapp-mcp/commit/6d23c433349bf0101707fad757207a19667d5c35))
* **cards:** discard a card, and require a play only above the hand limit ([#49](https://github.com/chrischall/warapp-mcp/issues/49)) ([1c77ad7](https://github.com/chrischall/warapp-mcp/commit/1c77ad7649412112d265b7ec99fae0b8b37f2a95))
* **cards:** play Bomb and Emergency Blockade, advise the spy cards, and close the card and team gaps from parts C and D ([#261](https://github.com/chrischall/warapp-mcp/issues/261)) ([64383df](https://github.com/chrischall/warapp-mcp/commit/64383dff4f286e35e4aec16f08093ae170b580ff))
* **cards:** play Gift, Airlift, Diplomacy, Sanctions and the Spy cards, advise them, and honour a Diplomacy card in effect ([#249](https://github.com/chrischall/warapp-mcp/issues/249)) ([a274bbe](https://github.com/chrischall/warapp-mcp/commit/a274bbeb3064d3ca2b7ae0e36db6be5cb7e23744))
* **chat:** read chat by channel with unread counts, and send to your team ([#229](https://github.com/chrischall/warapp-mcp/issues/229)) ([5832977](https://github.com/chrischall/warapp-mcp/commit/58329776a78fbc190f9f55977742441bef028941))
* **check-plan:** try a stack that moves away, two opponents together, Multi-Attack chains and Local Deployment pools ([#200](https://github.com/chrischall/warapp-mcp/issues/200)) ([91ef5c6](https://github.com/chrischall/warapp-mcp/commit/91ef5c663e63da976a5977c8029e230a018ce5bd))
* chrome-less direct transport via the AuthToken cookie (local-only) ([#22](https://github.com/chrischall/warapp-mcp/issues/22)) ([7c27296](https://github.com/chrischall/warapp-mcp/commit/7c27296d9caf6909bf30fb1e97e0584f42fa486b))
* **commander:** refuse a submit that leaves my commander takeable, walk it out of reach, hold it for the worst case, and say how a game was lost ([#282](https://github.com/chrischall/warapp-mcp/issues/282)) ([fca7760](https://github.com/chrischall/warapp-mcp/commit/fca7760c832acfb66fe985be473da3118ac251fe))
* **diplomacy:** price a truce with warapp_advise_diplomacy, and let a chat message promise only what the plan does ([#239](https://github.com/chrischall/warapp-mcp/issues/239)) ([b0fc41f](https://github.com/chrischall/warapp-mcp/commit/b0fc41fd76925279e7f876ded94babe3e02fadf5))
* game, map, board-analysis and route tools ([e4a0098](https://github.com/chrischall/warapp-mcp/commit/e4a0098195a87bc72eee08e46748f2dafe61fa8e))
* GameFeed API client with normalized games, map cache and loose board parser ([c368a22](https://github.com/chrischall/warapp-mcp/commit/c368a22ee94b5d3e1ab15e4aca1daaa4d71a99c7))
* **games:** list and join open games without the browser ([#34](https://github.com/chrischall/warapp-mcp/issues/34)) ([e5431ed](https://github.com/chrischall/warapp-mcp/commit/e5431edda38d3946f65ee7caecf1f53f375a283b))
* **games:** surrender a game (or take it back) without the browser ([#39](https://github.com/chrischall/warapp-mcp/issues/39)) ([c065ee8](https://github.com/chrischall/warapp-mcp/commit/c065ee8835e478b6e66ee3cd9a3c85d585159658))
* **join:** leave a lobby with warapp_leave_game, and mark lotteries from the game data ([#219](https://github.com/chrischall/warapp-mcp/issues/219)) ([79a43cb](https://github.com/chrischall/warapp-mcp/commit/79a43cb0f269a26f56254b4158b9da3ae93716bc))
* **join:** say when a lobby breaks the joining policy, and the skill's supervision checks from lost games ([#195](https://github.com/chrischall/warapp-mcp/issues/195)) ([8909fd9](https://github.com/chrischall/warapp-mcp/commit/8909fd97de53c78b363a1bfbd709be32b364ae26))
* list your games and scout opponents ([#10](https://github.com/chrischall/warapp-mcp/issues/10)) ([90f2680](https://github.com/chrischall/warapp-mcp/commit/90f268017ff6746802a42795283defd87355dc7c))
* live board, territory picks and chat through the war.app web client ([#6](https://github.com/chrischall/warapp-mcp/issues/6)) ([7079ff7](https://github.com/chrischall/warapp-mcp/commit/7079ff7d897cc21a71f5aa35b818da74f305aa2b))
* **live-board:** show commanders and other special units on the live board ([#66](https://github.com/chrischall/warapp-mcp/issues/66)) ([2402c64](https://github.com/chrischall/warapp-mcp/commit/2402c64bde5f48f1397645b5f6983d269c592068))
* **live:** start a speed game's first turn with warapp_begin_turn ([#50](https://github.com/chrischall/warapp-mcp/issues/50)) ([36cd63e](https://github.com/chrischall/warapp-mcp/commit/36cd63edcf22bd7d20bacc05b9031999c334fcda))
* opt-in per-map statistics from finished ladder games (warapp_map_stats) ([#80](https://github.com/chrischall/warapp-mcp/issues/80)) ([3b3014b](https://github.com/chrischall/warapp-mcp/commit/3b3014bb8f3a8f438376fbf3eeac76877db2cbec))
* **picks:** a pick advisor for manual-distribution games ([#46](https://github.com/chrischall/warapp-mcp/issues/46)) ([5bc0cf5](https://github.com/chrischall/warapp-mcp/commit/5bc0cf525787c4b6d556c5b0ddd57017b1696893))
* **picks:** offer a coverage-first alternative pick list beside the compact primary ([#191](https://github.com/chrischall/warapp-mcp/issues/191)) ([f4f8f8e](https://github.com/chrischall/warapp-mcp/commit/f4f8f8e0f4c0fa30f95039330a8dc45e10c81d5a))
* **picks:** read what the award of picks reveals: the opponent's starts, who moves first and where its commander began ([#174](https://github.com/chrischall/warapp-mcp/issues/174)) ([9cdef5c](https://github.com/chrischall/warapp-mcp/commit/9cdef5ceb12255d45c5444d626d81d0f27021d92))
* **picks:** weigh double borders, credit a bonus by who can reach it, take a neutral in two orders, and pick 1v1 fallbacks that answer the loss ([#177](https://github.com/chrischall/warapp-mcp/issues/177)) ([61996f2](https://github.com/chrischall/warapp-mcp/commit/61996f250178f2246edd157f68a85f8f2f42ab98))
* plan and submit a war.app turn, confirmed from game state ([#9](https://github.com/chrischall/warapp-mcp/issues/9)) ([d69d95a](https://github.com/chrischall/warapp-mcp/commit/d69d95af14b6130e74d4ad99fe434cd79c0c6d77))
* **planner:** a since-last-turn line, Multi-Attack chains as a threat, holds sized by standing, FFA absorb and leader holds ([#206](https://github.com/chrischall/warapp-mcp/issues/206)) ([922085d](https://github.com/chrischall/warapp-mcp/commit/922085d190d44d3006250f27167022fc7d5721ce))
* **planner:** adapt plans to the game (1v1, FFA, teams, phase, standing) and report exact win chances under luck ([#79](https://github.com/chrischall/warapp-mcp/issues/79)) ([91a46bc](https://github.com/chrischall/warapp-mcp/commit/91a46bc963781d1a4ea6878ab90ceb190f559e18))
* **planner:** commanders matter, and withdraw committed orders with warapp_uncommit_turn ([#67](https://github.com/chrischall/warapp-mcp/issues/67)) ([796b7af](https://github.com/chrischall/warapp-mcp/commit/796b7af322570ed53499de3860b20c1ed5251023))
* **planner:** defensibility-aware turn planner (realistic enemy income, holdable bonuses, combined attacks) ([#33](https://github.com/chrischall/warapp-mcp/issues/33)) ([88c84a0](https://github.com/chrischall/warapp-mcp/commit/88c84a0fbc187d7714a8c29981d875c33332b01d))
* **planner:** estimate the opponent's opening income from the starts the award of picks proved ([#190](https://github.com/chrischall/warapp-mcp/issues/190)) ([1f567be](https://github.com/chrischall/warapp-mcp/commit/1f567be6c385309516d8d2ef42e440fe9b044925))
* **planner:** every capture pays for the frontier it adds, with a frontier budget ([#90](https://github.com/chrischall/warapp-mcp/issues/90)) ([9b40c19](https://github.com/chrischall/warapp-mcp/commit/9b40c194424af0d73713b7ea92ac8d178ac18f69))
* **planner:** exchanges and FFA targets, finishing a player, won/lost/stuck, bomb-sized holds, guard-off play, card pieces and the fogged threat model ([#202](https://github.com/chrischall/warapp-mcp/issues/202)) ([ebc378f](https://github.com/chrischall/warapp-mcp/commit/ebc378fdc23c25b74d76831695ce6f076b4bcc98))
* **planner:** finish off or cut down a weak opponent instead of conceding to it ([#52](https://github.com/chrischall/warapp-mcp/issues/52)) ([f246269](https://github.com/chrischall/warapp-mcp/commit/f2462697d2d461115f987ad02cc094c8fb271cc6))
* **planner:** go on offence — break inferred bonuses, size breaks to land, strike when behind in a 1v1 ([#91](https://github.com/chrischall/warapp-mcp/issues/91)) ([252c6e5](https://github.com/chrischall/warapp-mcp/commit/252c6e52e9c453dbf7da5c604c322180da7e3b61))
* **planner:** handle One Army Must Stand Guard on and off: a second line, raids and retakes with the guard off, named in the profile, the open games list and the strategy notes ([#279](https://github.com/chrischall/warapp-mcp/issues/279)) ([eaa3878](https://github.com/chrischall/warapp-mcp/commit/eaa3878d27e49f146ba9040acffa85de3081b1c7))
* **planner:** honour a recorded truce in a free-for-all, report what a break would cost, and refuse an attack that breaks one unless meant ([#236](https://github.com/chrischall/warapp-mcp/issues/236)) ([7a7c1f0](https://github.com/chrischall/warapp-mcp/commit/7a7c1f06cd3e587972231cc0bbd1753c18636a6c))
* **planner:** obey the game's kill rates, Local Deployment and No-Split ([#42](https://github.com/chrischall/warapp-mcp/issues/42)) ([143a7be](https://github.com/chrischall/warapp-mcp/commit/143a7be64208431964f70932b922b6838a383c2e))
* **planner:** report each border's headroom, mark an opponent whose estimate broke untrusted, price a guard-off breach, and compare hand-edited orders with the plan's holds ([#301](https://github.com/chrischall/warapp-mcp/issues/301)) ([230f38e](https://github.com/chrischall/warapp-mcp/commit/230f38e2a2244eac0f41be8633b55851b008adb6))
* **planner:** take land a player who is out vacated, and empty enemy territory on the same front, even past the frontier rule; say how a seat was lost while the game plays on ([#284](https://github.com/chrischall/warapp-mcp/issues/284)) ([c9e2939](https://github.com/chrischall/warapp-mcp/commit/c9e2939faf657f54263071747b90d4d1bc0e9926))
* **plan:** offer a randomized deploy split (guess) at a border no fixed split holds ([#204](https://github.com/chrischall/warapp-mcp/issues/204)) ([a7e8a3a](https://github.com/chrischall/warapp-mcp/commit/a7e8a3aa8d5ec83b849acb8c02854d1c597f839a))
* **plan:** put an advised Order Delay in the orders, placed above its move ([#197](https://github.com/chrischall/warapp-mcp/issues/197)) ([8cc2a0e](https://github.com/chrischall/warapp-mcp/commit/8cc2a0ec45b0a217ce41eddc64c8092cff54dba9))
* play cards, wait for your turn, and plan against bigger enemy deploys ([#12](https://github.com/chrischall/warapp-mcp/issues/12)) ([7a74000](https://github.com/chrischall/warapp-mcp/commit/7a74000927ebec759e7958b84b671cefed30c869))
* **profiles:** count each opponent's habits across games and report them, inform-only ([#263](https://github.com/chrischall/warapp-mcp/issues/263)) ([71cd263](https://github.com/chrischall/warapp-mcp/commit/71cd2635626080a6bb497a14cfb1be1ea3ada5ce))
* pure map and board analysis core ([f6ae786](https://github.com/chrischall/warapp-mcp/commit/f6ae78679ebfb952e2ddf3f0bade26629be6364a))
* **push:** turn notifications over a direct WebSocket, no browser needed ([#40](https://github.com/chrischall/warapp-mcp/issues/40)) ([d5a1049](https://github.com/chrischall/warapp-mcp/commit/d5a1049b9dd0ba0a3d8ba31ab1cbb20b6711de06))
* **relations:** record truces in an agreement ledger, watch the board for breaches, and keep a hashed record of how players keep deals ([#231](https://github.com/chrischall/warapp-mcp/issues/231)) ([4597665](https://github.com/chrischall/warapp-mcp/commit/45976652b961c3e3476a86a69a84eb96d7ebf9b8))
* smarter turn planner — balanced goal, value-aware defence, threat trends ([#13](https://github.com/chrischall/warapp-mcp/issues/13)) ([ea7bc60](https://github.com/chrischall/warapp-mcp/commit/ea7bc60866c2dddf2a7763407bdba30e90f97c47))
* strategy notes for a game or a map (warapp_strategy) ([#84](https://github.com/chrischall/warapp-mcp/issues/84)) ([c77562a](https://github.com/chrischall/warapp-mcp/commit/c77562ace3cb822d236ba95664eda5845552a49e))
* **strategy:** 79 new notes offered only in games where they apply, a card clock, and corrections from a second research pass ([#162](https://github.com/chrischall/warapp-mcp/issues/162)) ([d3702d9](https://github.com/chrischall/warapp-mcp/commit/d3702d9dd3bd53abf3fbdabbe9e6727c88f93852))
* **strategy:** a chat and diplomacy playbook in the skill, and notes on truces and deals in a free-for-all ([#241](https://github.com/chrischall/warapp-mcp/issues/241)) ([dbe8ef9](https://github.com/chrischall/warapp-mcp/commit/dbe8ef9ef2789f16d7a53dcb148818d34fcfb5c1))
* **strategy:** end-game notes — finishing a won game, playing from behind, stand-offs, commanders, free-for-all and team endings ([#187](https://github.com/chrischall/warapp-mcp/issues/187)) ([ce17ebf](https://github.com/chrischall/warapp-mcp/commit/ce17ebf62895681c2284d50ec9b36347ae78996f))
* **strategy:** notes checked against the wiki, a standing that obeys the armies in view, truer chokepoints ([#116](https://github.com/chrischall/warapp-mcp/issues/116)) ([f944c96](https://github.com/chrischall/warapp-mcp/commit/f944c9642303bb388a165c2166c3964410c2b1c0))
* **submit:** place an Order Delay above a chosen move, and remember who moved first ([#196](https://github.com/chrischall/warapp-mcp/issues/196)) ([72ebb1d](https://github.com/chrischall/warapp-mcp/commit/72ebb1de3cfb34f406576be1a70c1faadf332ca4))
* **submit:** send Transfer Only, Attack Only, percentage, commander and attack-teammates orders ([#185](https://github.com/chrischall/warapp-mcp/issues/185)) ([6f1adea](https://github.com/chrischall/warapp-mcp/commit/6f1adea0e92fdc2d6a6d52b0136331a77b635b11))
* **teams:** coordinate picks with a teammate, advise focus, support and joint captures, brief the team, and choose a team on join ([#248](https://github.com/chrischall/warapp-mcp/issues/248)) ([13d65af](https://github.com/chrischall/warapp-mcp/commit/13d65af2aa16ef5e759266da6ecdf88d5a3ce39c))
* **teams:** every tool that decides teams falls back on the game list when GameFeed sends none, asked once per game ([#245](https://github.com/chrischall/warapp-mcp/issues/245)) ([69889e2](https://github.com/chrischall/warapp-mcp/commit/69889e22d54efc0ff1e2dc3d02c44a16f9a38c6b))
* **teams:** read my team and its entered orders, make picks and the planner team-aware ([#243](https://github.com/chrischall/warapp-mcp/issues/243)) ([4dca9a7](https://github.com/chrischall/warapp-mcp/commit/4dca9a7215e3af2afdcb2ca85bcb2f6815afee7c))
* **tools:** warapp_check_plan looks one turn ahead for territories a stack two steps away can reach ([#160](https://github.com/chrischall/warapp-mcp/issues/160)) ([6e6af5c](https://github.com/chrischall/warapp-mcp/commit/6e6af5cce3564ad1ad7f7d1f3bf8d4802750b49c))
* **tools:** warapp_check_plan, a stress test for a planned turn ([#153](https://github.com/chrischall/warapp-mcp/issues/153)) ([f48104e](https://github.com/chrischall/warapp-mcp/commit/f48104ec39503717b861d8bbecfca4f9f95c1e15))
* **tools:** warapp_locate_opponents — where each opponent probably is, what it is doing, and what to prepare for ([#183](https://github.com/chrischall/warapp-mcp/issues/183)) ([b28620f](https://github.com/chrischall/warapp-mcp/commit/b28620f312f349a2a22154c3c140855595e48f6e))
* track opponents out of sight and warn what they could be banking ([#95](https://github.com/chrischall/warapp-mcp/issues/95)) ([6e88b5b](https://github.com/chrischall/warapp-mcp/commit/6e88b5baced6071a2e760cc07fe67111959d68e7))
* track opponents over the board history with warapp_track_opponents ([#81](https://github.com/chrischall/warapp-mcp/issues/81)) ([b827e12](https://github.com/chrischall/warapp-mcp/commit/b827e120f3123468a72b068bcaee58ce5f1c901d))
* turn planner for deploys and captures ([#5](https://github.com/chrischall/warapp-mcp/issues/5)) ([a392696](https://github.com/chrischall/warapp-mcp/commit/a392696cc1a92aedee7c5846359bdd5f58e5186b))
* warapp-mcp and warapp-api skills with a bash/zsh GameFeed helper ([592e7e2](https://github.com/chrischall/warapp-mcp/commit/592e7e250890bfa85c3c1210368cc257fc0d99a3))


### Bug Fixes

* **advisors:** FFA contact means a real threat, map statistics skip unreadable games, current plannerGaps ([#135](https://github.com/chrischall/warapp-mcp/issues/135)) ([8037219](https://github.com/chrischall/warapp-mcp/commit/80372197f2239a1932f8aed5c68a69ff705809fb))
* **bundle:** never prune another live process's partial download ([#141](https://github.com/chrischall/warapp-mcp/issues/141)) ([3631ff5](https://github.com/chrischall/warapp-mcp/commit/3631ff5f78a0e3c3c721f97b784e0359b1084eab))
* **cards:** keep the timing cards, advise Order Delay, hold Reinforcement for a team, and warn of Bomb, Emergency Blockade and cards in effect ([#181](https://github.com/chrischall/warapp-mcp/issues/181)) ([9899f80](https://github.com/chrischall/warapp-mcp/commit/9899f809154c90a028dfc840f0bcbdff2e4fa5ba))
* **cards:** read the card type from Gb (last int), not the first integer ([#21](https://github.com/chrischall/warapp-mcp/issues/21)) ([cd2c78b](https://github.com/chrischall/warapp-mcp/commit/cd2c78b5e6b64e028051b293ea90d1a058d374b2))
* **cards:** read the real hand and play Order Delay in its turn phase ([#25](https://github.com/chrischall/warapp-mcp/issues/25)) ([4093f3c](https://github.com/chrischall/warapp-mcp/commit/4093f3c456a7b378f1fc12f4d9f0c908318c4a40))
* **chat:** read a GameFeed chat date with no zone as UTC, so seen messages stop reading as new ([#244](https://github.com/chrischall/warapp-mcp/issues/244)) ([21fed69](https://github.com/chrischall/warapp-mcp/commit/21fed69b4e8f4d0ddf5d4d621ef8277f3b64dcaf))
* **direct:** never resend a write after a 5xx or signed-out reply ([#26](https://github.com/chrischall/warapp-mcp/issues/26)) ([bd839a8](https://github.com/chrischall/warapp-mcp/commit/bd839a834c665cd196d51f8bbb1798e61c2073da))
* **games:** join open games with a colour, and mark lobbies already joined ([#41](https://github.com/chrischall/warapp-mcp/issues/41)) ([07f8792](https://github.com/chrischall/warapp-mcp/commit/07f87928fb8e0472ba66e275e7dc9f688e7eda53))
* **income:** apply the army cap to the plan and the deploy check, and spend idle armies when the cap would waste income ([#262](https://github.com/chrischall/warapp-mcp/issues/262)) ([26b7a6c](https://github.com/chrischall/warapp-mcp/commit/26b7a6c6ce8cca465affd31489b39a752d77b974))
* **income:** apply the game's overridden bonus values everywhere ([#63](https://github.com/chrischall/warapp-mcp/issues/63)) ([22ae068](https://github.com/chrischall/warapp-mcp/commit/22ae06800f25cfe5d43506a5717a32d5945048e5))
* **income:** one income rule for plan, submit, analysis and next income; name the card armies ([#88](https://github.com/chrischall/warapp-mcp/issues/88)) ([92f637b](https://github.com/chrischall/warapp-mcp/commit/92f637be3a17e0f569da927e08237b8692f630f7))
* **income:** territory armies replace the base income instead of adding to it ([#48](https://github.com/chrischall/warapp-mcp/issues/48)) ([d0058cc](https://github.com/chrischall/warapp-mcp/commit/d0058cc26e5cb5d3cf367d822c1594dfa3e91019))
* **interp:** evaluate the client's runtime type checks (casts, instanceof, interface checks) ([#173](https://github.com/chrischall/warapp-mcp/issues/173)) ([2482899](https://github.com/chrischall/warapp-mcp/commit/2482899bb707760703ffd24c4c5e6ba6544a51d7))
* **interp:** support typeof, which the client's runtime type checks use ([#159](https://github.com/chrischall/warapp-mcp/issues/159)) ([f9a0c70](https://github.com/chrischall/warapp-mcp/commit/f9a0c70f92b8dd5ef7dd41e5a70b96bb54272ebd))
* **join:** a likely lottery breaks the joining policy, a 12-hour boot passes, and leaving a lobby is verified live ([#223](https://github.com/chrischall/warapp-mcp/issues/223)) ([85a3ca4](https://github.com/chrischall/warapp-mcp/commit/85a3ca4188a6d8837bd9b850dbfe76522b980226))
* **live:** a wrong board can no longer read as verified, fewer map downloads, and the remaining push gaps ([#155](https://github.com/chrischall/warapp-mcp/issues/155)) ([5667ab6](https://github.com/chrischall/warapp-mcp/commit/5667ab61dfa92fee1f52771bdc825ace8f2c707d))
* **live:** refuse malformed boards, keep Light Fog owners, catch the first turn notification, pace the push loop ([#139](https://github.com/chrischall/warapp-mcp/issues/139)) ([0a64f34](https://github.com/chrischall/warapp-mcp/commit/0a64f34eb79521154c9c5783734bca47c2d81a22))
* **locate:** the full view keeps every hidden territory the compact view shows ([#193](https://github.com/chrischall/warapp-mcp/issues/193)) ([0ede078](https://github.com/chrischall/warapp-mcp/commit/0ede078003306b3844259641f3c2f22eefbbc421))
* make CI pass — zsh-optional helper tests and declared env vars ([#3](https://github.com/chrischall/warapp-mcp/issues/3)) ([46e64f5](https://github.com/chrischall/warapp-mcp/commit/46e64f5d9ef3105adbad88754433dc5ad129c3e4))
* **map-stats:** point the assumptions at the per-call unreadable count ([#137](https://github.com/chrischall/warapp-mcp/issues/137)) ([1b9b151](https://github.com/chrischall/warapp-mcp/commit/1b9b15164dabfa80b042b758a5ae14daaf0eeea7))
* **my-games:** read every game instead of the dashboard's ten, let the chat inbox take game ids, and step idle stacks toward the enemy front ([#267](https://github.com/chrischall/warapp-mcp/issues/267)) ([4df1889](https://github.com/chrischall/warapp-mcp/commit/4df18898493c04f64abfb662a8765e2635aa9958))
* **picks:** best compact primary, a fallback scored with the primary taken, negative bonuses and the award order ([#142](https://github.com/chrischall/warapp-mcp/issues/142)) ([d5a5b56](https://github.com/chrischall/warapp-mcp/commit/d5a5b562f40d97114643f2a0b455ead3ea383ba4))
* **picks:** keep 1v1 picks compact; the fallback list covers a counter-pick ([#76](https://github.com/chrischall/warapp-mcp/issues/76)) ([e4baffb](https://github.com/chrischall/warapp-mcp/commit/e4baffb3dd456533fb55d72fcd830a8a20f9615e))
* **picks:** realistic completion turns and honestly compact pick groups ([#53](https://github.com/chrischall/warapp-mcp/issues/53)) ([9fb47a5](https://github.com/chrischall/warapp-mcp/commit/9fb47a521286b84c9e9cc2c101123ecd06578e23))
* **picks:** try every seed before relaxing the hop limit ([#144](https://github.com/chrischall/warapp-mcp/issues/144)) ([a6bce33](https://github.com/chrischall/warapp-mcp/commit/a6bce3358f969a91c8044bffd50e453894800b6f))
* **planner:** a border that cannot hold attacks out instead of pinning its armies, and holds are sized for the worse move order ([#227](https://github.com/chrischall/warapp-mcp/issues/227)) ([17b9a9d](https://github.com/chrischall/warapp-mcp/commit/17b9a9d943759fbb5a68d7ceac8951694b18474b))
* **planner:** a capture that completes a bonus is never ranked last for opening a second front, and a twice-repulsed target is attacked only at a size that lands ([#242](https://github.com/chrischall/warapp-mcp/issues/242)) ([67a7a26](https://github.com/chrischall/warapp-mcp/commit/67a7a26a5799088597253eeee2c22955dd0faf44))
* **planner:** a closest-bonus lead step can be funded on a conceded source, and an unseen opponent's likely high is a modest labelled prior ([#216](https://github.com/chrischall/warapp-mcp/issues/216)) ([ba54ccb](https://github.com/chrischall/warapp-mcp/commit/ba54ccb0f4ce34b353e75584918d554e903c1431))
* **planner:** a lead step toward the closest bonus can leave a held border, and the outlook can call a fogged win on a labelled estimate ([#213](https://github.com/chrischall/warapp-mcp/issues/213)) ([cdd68fb](https://github.com/chrischall/warapp-mcp/commit/cdd68fb1172a325171359ac10d80941430c16a36))
* **planner:** a lead step toward the closest bonus takes this turn's deploy, and a fogged opponent's armies are bounded in the outlook ([#207](https://github.com/chrischall/warapp-mcp/issues/207)) ([b2a53b0](https://github.com/chrischall/warapp-mcp/commit/b2a53b0fd261322f4a51f8d344223e1481b987d3))
* **planner:** a stack that captures out of the fog is a threat, not enemy income ([#87](https://github.com/chrischall/warapp-mcp/issues/87)) ([22863f3](https://github.com/chrischall/warapp-mcp/commit/22863f35c3af0a338b24e18aeff4cef2da4e1e21))
* **planner:** commit to the closest bonus, never stand still, defend local bonuses and spend the strike stack ([#105](https://github.com/chrischall/warapp-mcp/issues/105)) ([e03a925](https://github.com/chrischall/warapp-mcp/commit/e03a925e03f081cbc4252510cb22c7f81d75ea4c))
* **planner:** defend a held bonus before expansion that completes nothing ([#56](https://github.com/chrischall/warapp-mcp/issues/56)) ([4b3878d](https://github.com/chrischall/warapp-mcp/commit/4b3878d2ff863928e7a91512d262702291d28f59))
* **planner:** even-start FFAs get a fog prior that yields to evidence, a leader's border is held against one opponent at a time, and the leftover takes what it pays for ([#237](https://github.com/chrischall/warapp-mcp/issues/237)) ([4b928bf](https://github.com/chrischall/warapp-mcp/commit/4b928bf93b16fbf0eb00cabcebd2719c0f08aef5))
* **planner:** fund closest-bonus steps at their bare cost, pace unseen and FFA opponents on real incomes, give strikes a margin, and stage the leftover ([#234](https://github.com/chrischall/warapp-mcp/issues/234)) ([c95883e](https://github.com/chrischall/warapp-mcp/commit/c95883e191be65ab354c74f1bed74159a1166998))
* **planner:** hold a weak member of a bonus completed this turn before any margin, and fold games finished before profiling ([#269](https://github.com/chrischall/warapp-mcp/issues/269)) ([18783be](https://github.com/chrischall/warapp-mcp/commit/18783bea7d1935f478a9835a3c2cb6f4aa07aa5f))
* **planner:** keep a held bonus's hold against a stack two steps away ([#188](https://github.com/chrischall/warapp-mcp/issues/188)) ([ad7a7cf](https://github.com/chrischall/warapp-mcp/commit/ad7a7cfea25c2df500c73ba0f390de4c86276f28))
* **planner:** move an idle stack into a conceded border it makes hold, echo the game's own Transfer Only, lead the income-jump line with its verdict, and add warapp_chat_inbox ([#258](https://github.com/chrischall/warapp-mcp/issues/258)) ([8cefbb7](https://github.com/chrischall/warapp-mcp/commit/8cefbb7e77f74e6f18cd25548c2ec8b2ee9d3b80))
* **planner:** never stand still by emptying a border that holds ([#115](https://github.com/chrischall/warapp-mcp/issues/115)) ([6b636a8](https://github.com/chrischall/warapp-mcp/commit/6b636a8c467eccc9f7b6ec0296d0736f0f4e8831))
* **planner:** never stand still in an FFA opening or in contact ([#111](https://github.com/chrischall/warapp-mcp/issues/111)) ([dcb9e1a](https://github.com/chrischall/warapp-mcp/commit/dcb9e1a586be6bfce638d2054e4f161160c5a95e))
* **planner:** No-Split moves whole stacks, held bonuses keep a floor, borders stay manned, attacks sized for the owner's deploy ([#138](https://github.com/chrischall/warapp-mcp/issues/138)) ([0a92579](https://github.com/chrischall/warapp-mcp/commit/0a92579e1d00a64d3627ed155857c6b9cf373a00))
* **planner:** read enemy income from growth, keep near-miss garrisons, pressure despite fog ([#65](https://github.com/chrischall/warapp-mcp/issues/65)) ([0f93aca](https://github.com/chrischall/warapp-mcp/commit/0f93aca95f97a485eb89e680ca03c940bbf0328b))
* **planner:** report attacks from the strike stack as kind strike-attack ([#108](https://github.com/chrischall/warapp-mcp/issues/108)) ([fc29c0f](https://github.com/chrischall/warapp-mcp/commit/fc29c0fbe1298da29b511af55931f17b6a940eec))
* **planner:** report the next income a plan's concessions put at risk ([#110](https://github.com/chrischall/warapp-mcp/issues/110)) ([7964d04](https://github.com/chrischall/warapp-mcp/commit/7964d04c2fc5645668aeb13b4511162522f7624e))
* **planner:** spread leftover armies so the smallest deploy that breaks any border facing one opponent is as large as possible ([#278](https://github.com/chrischall/warapp-mcp/issues/278)) ([a09de88](https://github.com/chrischall/warapp-mcp/commit/a09de881448ad0234feee97f4d49fce579a4b394))
* **planner:** stacks revealed from the fog no longer count as enemy income ([#77](https://github.com/chrischall/warapp-mcp/issues/77)) ([e5f44c8](https://github.com/chrischall/warapp-mcp/commit/e5f44c8b352953bddea51eb9bf8be5fa7740f268))
* **planner:** stop taking negative bonuses that lower income; score bonus clusters by net worth ([#89](https://github.com/chrischall/warapp-mcp/issues/89)) ([fdf0ec5](https://github.com/chrischall/warapp-mcp/commit/fdf0ec5221c4f2eafe93de10c9a456d6da0a61d9))
* **planner:** the contact fallback counts the frontier as armies at risk, not a veto ([#117](https://github.com/chrischall/warapp-mcp/issues/117)) ([d9a8d9c](https://github.com/chrischall/warapp-mcp/commit/d9a8d9cb91ef38c2a92b5c49c65c29adbe62d86a))
* **planner:** the contact fallback takes the capture that loses the fewest armies ([#113](https://github.com/chrischall/warapp-mcp/issues/113)) ([c94c17a](https://github.com/chrischall/warapp-mcp/commit/c94c17a8e199b3fbe54606d92ad4c3b62e06cb8c))
* **planner:** treat a surrendered player as static land, read deploy evidence the tracker missed, and close four planner gaps ([#280](https://github.com/chrischall/warapp-mcp/issues/280)) ([06e7495](https://github.com/chrischall/warapp-mcp/commit/06e7495df468f20c5bfcc5c4c3fa819d8ef75e32))
* **planner:** truer opponent income, an economy test on armies lost, exact sizing under luck, moves in turn order, and the threat-model gaps ([#175](https://github.com/chrischall/warapp-mcp/issues/175)) ([96ed177](https://github.com/chrischall/warapp-mcp/commit/96ed1773eb60d9fb25679a449e633644a5249a39))
* **planner:** under fog, a 1v1 standing comes from tracked income ([#98](https://github.com/chrischall/warapp-mcp/issues/98)) ([fd26259](https://github.com/chrischall/warapp-mcp/commit/fd2625975dde8cf4bd1c0557fcb89eb2c9d72ae3))
* **relations:** never count a teammate as an opponent or a tacit truce partner, and cover the team fallback in four more tools ([#247](https://github.com/chrischall/warapp-mcp/issues/247)) ([b056d9a](https://github.com/chrischall/warapp-mcp/commit/b056d9a37c94e6fc9af55940be1af31b22486af4))
* **scout:** report the player id as the exact token string ([#15](https://github.com/chrischall/warapp-mcp/issues/15)) ([cbcd6a0](https://github.com/chrischall/warapp-mcp/commit/cbcd6a03c3157a0cedde0511e22b2a8f7afce8f9))
* **security:** a direct transport player text cannot steer, a session bound to this machine and account, and writes that act as the account approved ([#150](https://github.com/chrischall/warapp-mcp/issues/150)) ([ddebc74](https://github.com/chrischall/warapp-mcp/commit/ddebc747d5640fa78e839fcfe14c67bf6192d4f5))
* **security:** a scouting parser players cannot steer, a pinned shell helper, and other players' names kept out of instructions ([#147](https://github.com/chrischall/warapp-mcp/issues/147)) ([63de490](https://github.com/chrischall/warapp-mcp/commit/63de490f1eefd62b93542cb7de81ae94336b6e6e))
* **security:** the client bundle is interpreted as hostile code, within fixed bounds, and loaded from cache only when its bytes verify ([#152](https://github.com/chrischall/warapp-mcp/issues/152)) ([7391eb7](https://github.com/chrischall/warapp-mcp/commit/7391eb7404c20229ade70e05fed14ced2b081748))
* **session:** say the decoder is not checked yet instead of leaving it out ([#157](https://github.com/chrischall/warapp-mcp/issues/157)) ([1f5fb63](https://github.com/chrischall/warapp-mcp/commit/1f5fb639a48d5f5df4e4ea19d5a0f5d8653228d2))
* **strategy:** keep a notes field in the topic index, as ids and topics ([#170](https://github.com/chrischall/warapp-mcp/issues/170)) ([e61b286](https://github.com/chrischall/warapp-mcp/commit/e61b286c83a80d4ba1f75f2a1d3401e4b05983d2))
* submit picks only as the signed-in war.app account ([#8](https://github.com/chrischall/warapp-mcp/issues/8)) ([6256203](https://github.com/chrischall/warapp-mcp/commit/62562030c55cb93a0d52dfd475fc230648b33ee3))
* **submit:** commit an empty turn when there is nothing to deploy ([#210](https://github.com/chrischall/warapp-mcp/issues/210)) ([6d33eda](https://github.com/chrischall/warapp-mcp/commit/6d33eda68523c1da3c2e8e65cbafccd42f07d67e))
* **submit:** judge attacks on one target in order so a planned combined capture is not called impossible, and say why a one-turn income jump is believed ([#251](https://github.com/chrischall/warapp-mcp/issues/251)) ([fb2644a](https://github.com/chrischall/warapp-mcp/commit/fb2644a6a527de4e3ae1a8b457dbb822a65d3abe))
* **submit:** refuse a Blockade on the territory holding my commander ([#169](https://github.com/chrischall/warapp-mcp/issues/169)) ([393d655](https://github.com/chrischall/warapp-mcp/commit/393d655c6279de3c1223358bbc07c6f6d77faafe))
* **tools:** one meaning of turn, an income override after error 11, terminal waits, and clearer previews ([#145](https://github.com/chrischall/warapp-mcp/issues/145)) ([713d254](https://github.com/chrischall/warapp-mcp/commit/713d254e38a9575749bf57c572271e930054e254))
* **tools:** one write kit for every write, stricter checks and a linter, and docs that match the code ([#209](https://github.com/chrischall/warapp-mcp/issues/209)) ([abce430](https://github.com/chrischall/warapp-mcp/commit/abce4304d401ba51693d13f9a7bd71e42a386ab0))
* **tracker:** estimate opponent income from the highest observed deploy, not the median ([#100](https://github.com/chrischall/warapp-mcp/issues/100)) ([a635da3](https://github.com/chrischall/warapp-mcp/commit/a635da3e71346262e8db14a809a7f2dac43ea1c6))


### Refactor

* **planner:** split planTurn into phase modules, pinned by a golden corpus of 6,253 plans ([#211](https://github.com/chrischall/warapp-mcp/issues/211)) ([137d7b3](https://github.com/chrischall/warapp-mcp/commit/137d7b39d5d4123535696258a45aac088bf931b4))


### Documentation

* **chat:** automated chat is off until the owner enables it ([#252](https://github.com/chrischall/warapp-mcp/issues/252)) ([fbb7d38](https://github.com/chrischall/warapp-mcp/commit/fbb7d38adfabb043af7282bc801b29c3bc3e834e))
* document the war.app web-client protocol ([#2](https://github.com/chrischall/warapp-mcp/issues/2)) ([1a7d80b](https://github.com/chrischall/warapp-mcp/commit/1a7d80ba2a845b2be8a3d311acb322d16d3ffad4))
* **leave:** the error table's comment says error 4 is read back ([#221](https://github.com/chrischall/warapp-mcp/issues/221)) ([ec1e742](https://github.com/chrischall/warapp-mcp/commit/ec1e7426f5b7aae09833ecd3d1bd90fc232db254))
* **live-board:** fog levels are war.app's names: You, Visible, OwnerOnly (armies hidden), Fogged ([#82](https://github.com/chrischall/warapp-mcp/issues/82)) ([a2446b2](https://github.com/chrischall/warapp-mcp/commit/a2446b23557b7ac67e2dc843c8354602b4065d37))
* **mint:** declare the player-record and player-profile switches for the hosted registration ([#266](https://github.com/chrischall/warapp-mcp/issues/266)) ([916d061](https://github.com/chrischall/warapp-mcp/commit/916d061ccbff39f5b9290a2d0e27db79118137f2))
* **normalize:** OverriddenBonuses comments say the shape is verified live ([#68](https://github.com/chrischall/warapp-mcp/issues/68)) ([1061afb](https://github.com/chrischall/warapp-mcp/commit/1061afb2f84d74db96cead28c03e11f757a8ee81))
* plan_turn's goal text matches the shared-deploy finish-off model ([#58](https://github.com/chrischall/warapp-mcp/issues/58)) ([0826779](https://github.com/chrischall/warapp-mcp/commit/0826779ee094a5678abfd6d8536272cc39904bbd))
* **skill:** add a checklist for supervising the planner ([#75](https://github.com/chrischall/warapp-mcp/issues/75)) ([3cbfda1](https://github.com/chrischall/warapp-mcp/commit/3cbfda1321109d64a1b20ff5e55505f06182c448))
* **skill:** trim the planner checklist to the gaps that remain ([#92](https://github.com/chrischall/warapp-mcp/issues/92)) ([1b99996](https://github.com/chrischall/warapp-mcp/commit/1b999964eb230e596eea62c7ee2f111142c0547c))
* **web-protocol:** document the socket.io push channel ([#24](https://github.com/chrischall/warapp-mcp/issues/24)) ([ca13074](https://github.com/chrischall/warapp-mcp/commit/ca130742f1b01d6ebe08cf9f57769128d7788970))
