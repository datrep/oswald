// scripts/record-2026-09-27-listing-and-scaling-sets.js
//
//   Registers TWO task sets from the two reports supplied 2026-09-27:
//     LST-9 .. LST-18   on edict 51 "Listing Workbench"  (sortOrder continues from 7)
//     SCL-1 .. SCL-10   on a NEW edict "Business Scaling" (SCL)
//
// Owner instruction 2026-09-27: "write both. Scaling work is a brand new policy segment."
//
// ★ SCHEMA TRAPS (same as create-trd-reg1-task.js / record-2026-09-25-cost-floor.js):
//   1. Tasks.plannedStart is NOT NULL with no column defaults, so it cannot be omitted.
//   2. Tasks.active is COMPUTED (GETUTCDATE() >= plannedStart) and must never be named in an INSERT.
//      A raw GETDATE() writes the server's LOCAL wall-clock (SGT, UTC+8), which lands the row with
//      active = 0 — created, present, and reading as not-yet-started. Pass a JS Date instead: the
//      mssql driver writes it as its UTC wall-clock.
//   3. state 1 = the OPEN band the dashboard lists; state 3 = the done pile. Edict 51 proves it:
//      LST-1..6 are state 3 (delivered) and LST-7/8 are state 1 (open). New rows go in at 1.
//   4. sortOrder is PER EDICT. A global MAX(sortOrder) would hand edict 51 a number from edict 52.
//   5. Tasks.name has NO uniqueness check — only id does. This script therefore guards idempotency
//      on a marker inside info, not on the label. (See TRD-REG-1.)
//
// ★ NO APOSTROPHE/ENCODING GAMBLE: every body goes through a parameterised NVARCHAR binding, so
//   em dashes and quotes are safe here. The sqlcmd mojibake trap does NOT apply to this path.
//
// Usage (repo root):
//   node scripts/record-2026-09-27-listing-and-scaling-sets.js          # DRY RUN
//   node scripts/record-2026-09-27-listing-and-scaling-sets.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');

// LIKE-safe marker: `[...]` in T-SQL LIKE is a CHARACTER CLASS, so brackets would make the guard
// match everything. `#` is not a metacharacter.
const MARK = '##2026-09-27 listing+scaling sets##';

const LST_EDICT = 51;          // "Listing Workbench"
const SCALING_NAME = 'Business Scaling';
const OPEN = 1;                // state 1 = the open band
const PRIORITY = 2;            // matches LST-7 / LST-8

const E = '\u2014';            // em dash, per the owner's title convention

// ---------------------------------------------------------------------------
// The new policy segment
// ---------------------------------------------------------------------------

const SCALING_INFO =
`${MARK}
★ CREATED 2026-09-27 from the "Scaling Report: KaguyaSakayori Budget PC Refurbishment" (dated 27 September 2026), supplied in chat. This edict is the durable home for that report and for the SCL- task set below; the report itself was not stored anywhere in the repo.

THE HOLDER'S STATED POSITION. Budget gaming PCs built from used and refurbished parts, stress-tested
(Prime95, MemTest86, CrystalDiskInfo), sold with a 7-day personal warranty, operating semi-informally
from an HDB flat in Bukit Panjang.

★ VERIFIED LIVE 2026-09-27 (the report's figures differ and the live listing WINS):
  - Carousell profile: 5.0 rating, 18 reviews, 14 orders, "8 months on Carousell" (the report says 7).
  - The report's claimed tier is "S$250-S$350"; the live catalogue actually runs S$98 to S$548, and two
    units sit BELOW the claimed tier (a SFF at S$98 against a S$105 parts cost, an OptiPlex 390 at S$120).
  - The report's "16GB RAM + 8GB GPU for S$280" is live at S$275.
  - Two listings that were already well written are the ones not selling, so the positioning thesis
    needs testing against price before it is built on. See LST-13.

THE THESIS. Bottom-feeders at S$200-300 are untested and unwarranted; credible builders (buildlah,
define.pc, shaoxiannn) do not touch sub-S$300. The claimed empty middle is a trusted independent with
documented testing and a real warranty. The review evidence for it exists: a buyer wrote "10/10 servicing
- deep cleaned and upgraded my super dusty and old pc" with the tags "Great communication, Above and beyond".

THE CONSTRAINTS. HDB Home Office Scheme forbids repair activities; HBBS is more permissive but forbids
soliciting, non-resident employees and signage; no business address; physical flyering is illegal under
HBBS and Town Council by-laws; the owner dislikes social media, so content has to run through someone
else. The report's phases: Phase 1 (0-6 months) semi-informal, Phase 2 (6-12 months) ACRA sole
proprietorship (~S$115) plus a business bank account. Three-month cash outlay: ~S$135.

⚠ NOTHING IN THIS SET HAS BEEN LEGALLY CHECKED. SCL-1 gates the rest: if hands-on repair is outside HBBS,
the operating model changes shape before any website or referral programme is worth building.`;

// ---------------------------------------------------------------------------
// LST-9 .. LST-18  — Listing Workbench
// ---------------------------------------------------------------------------

const LST = [
{
  name: `LST-9: Copy ${E} the title formula buries the warranty past the truncation point and never names a game, and four gaming listings still use the old shape`,
  info:
`${MARK}
FOUND 2026-09-27 by reading the two live listings the owner supplied side by side (the "new" 1458306987 and
the "old" 1458122534).

★ THE EVIDENCE. The new live title is 108 characters:
  "CHEAP ESPORTS READY PC | 8GB VRAM| 16GB RAM | 600GB storage | Warranty | DOCUMENTED PROOF OF TESTING IN DESC"
Carousell truncates titles in feed and search results, so "Warranty" and "DOCUMENTED PROOF OF TESTING" - the
two things that actually differentiate this seller from the S$200-300 bottom-feeders - are the LAST TWO ITEMS
and are the ones that get cut. The lead word is "CHEAP", which positions against the premium builders the
scaling report says he is not competing with.

★ THE SCALING REPORT'S OWN TEMPLATE IS BETTER, AND THE LIVE LISTING OVERRULES IT. Its section 5.1 says:
  "[TESTED & WARRANTIED] Esports Gaming PC | 8GB GPU, 16GB RAM | Fortnite/Valorant Ready"
Trust token FIRST, games NAMED. The standing rule for this pair of documents is "live overrules the report",
but here the report is right and the live listing is worse - recorded so the rule is not applied blindly.

★ THE DIRECTIVES REPORT ALSO REQUIRES THE GAMES. Its section 2 mandates a Game Ready Hook and its examples
carry named titles ("Fortnite & Valorant Ready", "Runs Fortnite/CS2"). The live title says only "ESPORTS
READY". Named games are the search terms buyers actually type.

PROPOSED SHAPE (inside the visible prefix, trust first, games named):
  [TESTED & WARRANTIED] Esports PC | 16GB RAM | 8GB VRAM | Fortnite/Valorant | Free Delivery BP

ROLLOUT: apply to the 24GB RX 580 (S$268), the 8700K (S$548) and any other gaming listing on the old shape.

ACCEPTANCE: every gaming listing opens with the trust token and names at least two games inside the visible
prefix; the reason the order is trust-first is written down so a later rewrite does not undo it.`
},
{
  name: `LST-10: Copy ${E} the esports listing advertises 600GB of storage against the 680GB of drives actually fitted`,
  info:
`${MARK}
FOUND 2026-09-27 on listing 1458306987 (ListingParts listingId 12, recorded cost S$220).

THE DEFECT: the title and the body both say "600GB storage". The same listing's own specification block reads
"Storage: 180GB Enterprise SSD (80% health, r/w tested), 500GB HDD", which is 680GB, and the Workbench parts
row for that machine is "180GB SSD + 500GB HDD" at S$15.00. So the listing UNDERSTATES its capacity by 80GB
and contradicts itself inside one document.

WHY THIS ONE MATTERS MORE THAN THE NUMBER. Capacity figures are the whole hook in this copy - the title's job
is to be a capacity slogan. An error there costs twice: the seller gives away the storage he paid for, and
the self-contradiction damages exactly the "documented, tested, honest" story the rest of the listing is
built on. A buyer who spots the arithmetic inside one page starts checking the FPS numbers too (see LST-12).

FIX: state 680GB, or state it as "180GB SSD + 500GB HDD" and let the buyer add it up. Do not round down.

ACCEPTANCE: no listing's capacity figures disagree with its own parts rows.`
},
{
  name: `LST-11: Terms ${E} the S$16 untracked delivery option promises shipping-damage cover that Carousell refuses, against a S$55 margin`,
  info:
`${MARK}
FOUND 2026-09-27 on listing 1458306987.

★ THE CONFLICT, IN TWO SENTENCES THAT SIT ON THE SAME PAGE.
  (a) Delivery block, live: "Paid Delivery: S$16 via Lalamove elsewhere"; Carousell's own text on that option
      reads "Seller's custom delivery S$16.00 - Same day delivery - Untracked - Lost or damaged untracked
      parcels are not eligible for return/refund".
  (b) Warranty block, live: "7-day personal warranty on hardware faults (incl. damage caused by shipping)".
So the seller has written a promise covering a loss the platform has explicitly excluded, and it comes out of
his own pocket. On this machine the whole margin is S$55 (S$275 sell against S$220 of parts), so one lost
untracked parcel consumes the sale entirely - and the loss is available to him at his own risk on EVERY
shipped unit, not just a bad one.

★ AND IT IS ALREADY INCONSISTENT WITH THE HOUSE TERMS. legal/templates/commercial-terms.md says the parts
regime is "14-day DOA only", with "No labour cover and no return-shipping cover". The listing is more generous
than the template it is supposed to sit under, which means the template does not currently describe what is
actually being sold.

OPTIONS: (a) drop the shipping-damage clause whenever the untracked option is used; (b) quote tracked and
price it; (c) keep the promise and self-insure deliberately, with the exposure written down. Any of the three
is defensible; the current state is an unwritten choice.

ACCEPTANCE: the listing's warranty wording and the delivery option it offers agree with each other and with
legal/templates/commercial-terms.md.`
},
{
  name: `LST-12: Copy ${E} the FPS figures differ by 67% between two listings with the same GPU, and they are now warranty claims`,
  info:
`${MARK}
FOUND 2026-09-27 by comparing the two listings the owner supplied.

SAME SELLER, SAME GPU (AMD RX 580 8GB GDDR5), SECOND-HAND CLAIMS THAT DO NOT AGREE:
  old listing 1458122534 (i7-3770): CS2 100+ / Minecraft 120+ / Astroneer 90+
  new listing 1458306987 (i7-4790): CS2 130+ / Minecraft 200+ / Astroneer 100+
The CPU difference is real and explains a modest delta - the 4790 is Haswell against Ivy Bridge with a higher
clock, and Minecraft is CPU-bound - but a 67% jump on Minecraft between two machines of the same GPU class,
published by the same seller on the same day, will not survive a buyer's own measurement.

★ WHY THIS IS NOW A MONEY PROBLEM, NOT A WORDING PROBLEM. Both listings promise a 7-day personal warranty on
hardware faults. A published number is therefore a claim a buyer can hold the seller to inside the warranty
window, and the untracked-delivery exposure in LST-11 gives an unhappy buyer a second lever. The old listing
also correctly notes that it does not cover every game - it says "MemTest86 passed" and names specific titles -
so the register is inconsistent rather than uniformly optimistic.

FIX: qualify every figure with the test conditions (1080p, that specific machine), or publish ONE repeatable
benchmark. The old listing already has the better instrument: "Unigine Heaven benchmark - 1798 Extreme preset"
is a comparable, repeatable score, and it is the kind of number the copy's credibility is built on.

ACCEPTANCE: no published performance figure lacks its test conditions, and the two listings stop contradicting
each other.`
},
{
  name: `LST-13: Catalogue ${E} the two RX 580 machines at S$275 and S$268 bid against each other`,
  info:
`${MARK}
FOUND 2026-09-27 while comparing the two live listings the owner supplied.

THE OVERLAP: listing 1458306987 (16GB RAM, RX 580 8GB, i7-4790) at S$275, cost S$220, margin S$55 - and
listing 1458122534 (24GB RAM, RX 580 8GB, i7-3770) at S$268, cost S$246, margin S$22. Same seller, same GPU,
same games, same warranty, S$7 apart.

★ WHY IT IS A DEFECT. A buyer who opens both has no reason to prefer either, so the only rational move is to
haggle the cheaper one - which is the machine with the S$22 margin. The rewrite in LST-9 has already improved
the presentation of the machine the seller makes MORE on, which is the right direction, but it happened as a
side effect of rewriting one listing rather than as a catalogue decision.

★ THIS IS NOT A COPY PROBLEM, AND THE COPY CANNOT FIX IT. Evidence from the same week: the 16GB machine had
14 likes under its plainer title (the most in the catalogue) and did not sell; the only hard offer across the
pair was S$173 on the S$268 machine against a 64.6% ask, and it was declined. Attention was never the
constraint on these two.

OPTIONS: (a) give them different jobs - the 16GB as the esports machine at S$275, the 24GB as the multitasking
machine at a different price point; (b) retire one; (c) accept the cannibalisation deliberately, which is
only defensible if it is written down. Note that the 24GB machine carries a real differentiator the 16GB one
cannot claim: a "Silverstone 650W PSU (with warranty (DFST650E2324030172))".

ACCEPTANCE: no two live listings compete on the same buyer for the same reason at the same price, or the
overlap is a recorded decision.`
},
{
  name: `LST-14: Money ${E} there is no buyback rule, and the first buyback is being priced live`,
  info:
`${MARK}
FOUND 2026-09-27 during a live negotiation. A buyer (Carousell firekoh99, a Professional Seller with 100+
reviews and 8 years on the platform) offered an ASUS VivoBook 14 X413FA-EK605T with a cracked panel, and a
Dell Inspiron 24 (7459) all-in-one. The laptop was offered at S$120; the AIO was declined.

★ NOTHING IN THE REPO DEFINES A BUYBACK. A grep of legal/ for buyback / trade-in / part exchange returns two
unrelated hits (a quote note about a CPU and a table row about used parts). So the first buyback in the
business's history is being priced from scratch, in chat.

THE RULE DERIVED AND AGREED 2026-09-27:
  fair buyback  =  60-65% of the realistic REALISED price
                   MINUS the parts you must supply
                   MINUS your own labour at the rate card rate
Worked: the laptop - realised S$200-240, panel S$35-40 (an Innolux N140HCA-EAC is live at S$35-40 in SG),
labour S$40 by the card's "repair/replacement" line, so S$90-110 offered and S$120 paid. The AIO - realised
S$200-240, an SSD to fit, same labour, so S$100-120; declined.

★ THE CAVEAT THAT MUST TRAVEL WITH THE RULE. Fair and maximum COINCIDE when the seller has their own route
to market. This seller can list both machines himself and net roughly S$310-370 over a few weeks, so there is
no justification for buying low; the money being paid for is time and risk. A walk-in with no alternative can
be bought lower, and that difference is the rule's whole content.

★ AND A SECOND DISTINCTION WORTH KEEPING. The laptop is loss-proof but not profitable: its removable parts
floor is S$120-155 (the 512GB NVMe alone is S$60-85 at 2026-09-27 prices), which covers the downside if the
panel swap fails - but collateral pays out if the job FAILS, not if it works. Safety is not a wage.

ACCEPTANCE: the rule, its caveat and both worked examples live in legal/ where the rate card and commercial
terms already are, so the next buyback is a lookup rather than a conversation.`
},
{
  name: `LST-15: Money ${E} partCost carries no as-of date, so every margin is anchored to a 2026-07-27 valuation in a rising parts market`,
  info:
`${MARK}
FOUND 2026-09-27 asked directly: "what would the computer inflation crisis factor into the price".

★ THE PROBLEM IS THAT THE COST BASIS HAS A DATE AND THE WORKBENCH DOES NOT KNOW IT. InventoryItems.valueCost
rows are dated 2026-07-27/28 and were imported 2026-08-19; ListingParts.partCost copies those same figures
into every listing. Measured against live Carousell asking prices 2026-09-27:
  512GB NVMe (assorted, in stock x9)   sheet S$45.00   live used S$60-85   -> 25-45% LOW
  8GB DDR4 SO-DIMM                     sheet S$5/GB    live S$25-45 each   -> roughly RIGHT
  14 inch FHD panel (N140HCA-EAC)      not stocked     live S$35-40
★ SO THE ERROR IS CONCENTRATED, NOT UNIVERSAL. NAND has run; DDR has not. Anyone who reacts to this by
re-pricing the whole sheet will corrupt the half that is still correct, and the nine S$45 SSDs are S$135-360
of unrealised appreciation that is real money released every time one is built into a machine.

★★ THE CONSEQUENCE THAT MATTERS MOST: the clearance prices are now below the REPLACEMENT cost of the parts
inside them. The SFF at S$98 (listingNo 1, id 11) carries S$105 of parts on the July sheet - before the SSD
and GPU lines moved. In an appreciating-parts market, part-out value can overtake whole-machine value, which
makes a below-cost clearance a genuine destroyer of value rather than a marketing decision. That is recorded,
not overruled: the owner is clearing deliberately because nothing sold in two months.

NEEDS: (a) an as-of date on the valuation, so a margin can state its vintage; (b) a revaluation path, so the
sheet can be marked to market on demand rather than only on import. Both are small; the absence of either is
what makes every printed margin silently wrong by an unknown amount.

ACCEPTANCE: every margin the Workbench prints carries the as-of date of the cost basis behind it.`
},
{
  name: `LST-16: UI ${E} Listings.other is written by the service and rendered nowhere, so a clearance at a loss reads as an error`,
  info:
`${MARK}
FOUND 2026-09-27 while the owner explained a deliberate loss.

★ THE FIELD ALREADY EXISTS AND IS INVISIBLE. Listings.other is the Excel "Other" column - the adjustment or
note slot. The service reads and writes it (listings/store.js lines 75, 105 and 127) and listings/routes.js
line 43 maps it out of the database. listings/public/js/app.v2.js renders "notes" on the listing form but
NEVER "other": the string appears in that file only as a PART_TYPE value and a fallback. A grep for the word
across the whole UI returns nothing else.

★ THE WORKED CASE. The owner is selling the SFF Desktop Office PC (listingNo 1 / id 11) at S$98 against a
S$105 parts cost, on purpose, because nothing sold it in two months and he wants the space. There is nowhere
in the Workbench to record that reason. So when it sells, the row will show a bare S$7 loss, indistinguishable
from a pricing error, and CostSettings.profitDanger is -34.00, which will not even flag it. The one number on
the dashboard that could explain the loss is the one that cannot be typed into it.

★ IT IS ALSO THE FIFTH UNUSED COLUMN. Every one of the 15 Listings rows has other = NULL, including the six
sold ones, so the field has never once carried the adjustment it was imported for. Either it should be
rendered and used, or its absence should be acknowledged - but a write-only column is the worst of both.

ACCEPTANCE: a listing can carry a stated reason for its price - clearance, markdown, fault, batch - and the
dashboard shows it next to the margin.`
},
{
  name: `LST-17: Cost ${E} two live component listings have no cost anywhere in the workbench`,
  info:
`${MARK}
FOUND 2026-09-27 by reconciling the Carousell manage-listings page against the Workbench.

THE TWO: "Thermalright Peerless Assassin 140 SE, Brand New and Sealed" at S$45 (listed 20 Sep 2026) and
"Segotep AN650W Power Supply" at S$55 (listed 20 Sep 2026). Together S$100 of asking price.

★ VERIFIED ABSENT, BY NAME MATCH: no Listings row, no InventoryItems row, and no PartPrices entry for either.
The stock sheet is 94 rows and the price list has no cooler or PSU under those names, so wherever those two
came from, the Workbench was never told what they cost.

WHY THAT IS THE DEFECT RATHER THAN THE MISSING NUMBER: the Workbench is the only place a margin can come
from, and these two will therefore read as roughly 100% margin the day they sell - a wrong number printed
confidently, which is the same failure mode as LST-8 and LST-7. The genuine question the record cannot
answer is whether they are stock bought to resell or leftovers from a build, and that question is the point:
the model has no way to express either.

★ FOURTH INSTANCE OF ONE FAMILY. LST-8 (a component that came with the unit), LST-10 (a capacity figure that
disagrees with its own parts rows), LST-15 (no as-of date on a valuation) and this - all four are the same
defect: the Workbench cannot see value it was not explicitly told about, and it prints a confident margin over
the gap anyway.

ACCEPTANCE: every live listing has a cost basis, or is explicitly marked as unpriced.`
},
{
  name: `LST-18: Docs ${E} the listing-generation directives live only in a chat message, so every rewrite re-derives the template`,
  info:
`${MARK}
FOUND 2026-09-27, when both reports were supplied: a "Carousell Listing Generation Directives" document and
the "Scaling Report". Neither is stored in the repo. The scaling report now has a home (edict "Business
Scaling"), but the directives still exist only as a chat message, so the next rewrite either re-derives them
or silently invents a different template.

★ THE DIRECTIVES ARE PARTLY STALE ALREADY, WHICH IS WHY THEY NEED TO BE STORED WITH THEIR DATES. They pitch
"32GB RAM" and "1.75TB storage" as the arbitrage; no live listing matches - the live pair is 16GB/680GB and
24GB/620GB. Section 2's title formula requires a capacity hook, a game hook AND a price anchor; neither live
title carries a price.

★ AND THE SAME RULE PRODUCED A SET OF CORRECTIONS WORTH RECORDING, because the rule is "where a report and a
live listing disagree, the live listing wins":
  directives: 32GB / 1.75TB                       -> live: 16GB/680GB and 24GB/620GB
  directives: title = capacity + game + price     -> live: no price in either title
  scaling 5.1: "[TESTED & WARRANTIED] ... Fortnite/Valorant Ready" -> live: no trust prefix, no games
  scaling 2.2: "16GB + 8GB GPU for S$280"         -> live: S$275
  scaling 2.2: "the S$250-350 tier"               -> live: S$98-548, two units below the tier
  scaling header: "7 months on platform"          -> live: 8 months

DELIVERABLE: the agreed template in legal/standards/, where carousell-framing-standard.md already lives, with
its figures corrected against the live catalogue and its date stamped. Sections that survive unchanged: the
value-arbitrage angle, the new-PC comparison, the PSU-by-name rule, the prohibition on the "wait for DDR5"
reframe, the tone rules, and the FPS-claim discipline from LST-12.

ACCEPTANCE: a rewrite can be produced from the repo alone, without the chat.`
}
];

// ---------------------------------------------------------------------------
// SCL-1 .. SCL-10  — Business Scaling
// ---------------------------------------------------------------------------

const SCL = [
{
  name: `SCL-1: Legal ${E} confirm HBBS allows hands-on repair work and inventory stored at other people's homes`,
  info:
`${MARK}
SOURCE: scaling report sections 3.1 and 3.3. GATES THE WHOLE SET.

★ WHAT IS CLAIMED, AND WHAT IS UNVERIFIED. The report states that the HDB Home Office Scheme explicitly
forbids repair activities, and that the Home-Based Business Scheme is more permissive but prohibits
soliciting, employees who do not live in the flat, and signage. Neither claim is verified anywhere in this
repo, and both govern whether the current operation is lawful as run. The report also flags its own
distributed-inventory model - stock stored in friends' and family homes - as a grey area that may constitute
a second business location.

★ TWO QUESTIONS, ONE WRITTEN ANSWER EACH:
  (a) Does hands-on repair and refurbishment - not just selling - fall inside HBBS for an HDB flat?
  (b) Does keeping stock at a non-resident's home create a second premises, and does paying them per trip
      make them an employee for HBBS purposes?
The report asserts (a) is answered no by the Home Office Scheme and yes-with-conditions by HBBS, and calls
(b) "acceptable if no employees and no soliciting". It does not say who said so.

⚠ NOTHING ELSE IN THIS SET SHOULD BE BUILT ON THE ASSUMPTION THAT THE ANSWER IS YES. A website, a referral
programme and ACRA registration are all cheap to do and expensive to undo, and they are all pointless if the
underlying activity is outside the scheme.

ACCEPTANCE: a dated written answer from HDB (and ACRA where the question turns on registration), stored in
legal/, and the operating model either confirmed or changed.`
},
{
  name: `SCL-2: Legal ${E} no physical flyering, and no signage`,
  info:
`${MARK}
SOURCE: scaling report section 3.1.

★ THE CLAIM: physical flyering is illegal under HBBS and Town Council by-laws, with fines up to S$5,000, and
the report is emphatic that this is "not a grey area". The same section forbids signage on the premises.

WHY THIS DESERVES A ROW OF ITS OWN RATHER THAN A LINE IN ANOTHER TASK: it is the one constraint that a later
AI, or a later version of the same plan, is most likely to re-propose as a growth tactic - door-to-door and
estate flyering are the standard cheap option for a home business and they are wrong here. A constraint that
is only in a chat message will be re-derived as a good idea.

DELIVERABLE: a one-paragraph constraint note in legal/, dated, naming the by-law and the penalty, that any
future marketing task can cite by reference. Confirm the actual by-law and the actual penalty for Bukit
Panjang Town Council rather than repeating the report's figure - S$5,000 is the report's number, not a
verified one.

ACCEPTANCE: a future marketing proposal can be refused by citing the note, without re-arguing the law.`
},
{
  name: `SCL-3: Web ${E} a domain and a static site (Home / About / Builds / Contact / Referral)`,
  info:
`${MARK}
SOURCE: scaling report section 4.1 (Phase 1, month 1-2).

THE PLAN: ~S$20/year for a .sg or .com domain; free static hosting on Vercel, Netlify or GitHub Pages, or a
cheap VPS at ~S$5/month only if dynamic features are genuinely needed. Purpose is legitimacy, portfolio and
referral sign-up - NOT a full e-commerce store at this stage. The report's own pitfall list: security,
payment integration and maintenance.

PAGES: Home (value proposition) / About (story, reviews) / Past Builds (photos, specs, sold prices) /
Contact (WhatsApp or Telegram) / Referral (sign-up; depends on SCL-6).

★ "PAST BUILDS WITH SOLD PRICES" IS THE PAGE THAT DOES THE WORK. The 5.0 rating with 18 reviews is the moat,
and the catalogue already contains the evidence - six recorded sales, and a review reading "10/10 servicing -
deep cleaned and upgraded my super dusty and old pc". A public track record page converts a stranger, which is
the whole reason the report wants a site rather than another listing channel.

★ THE ADDRESS RULE: no physical address on the site. Use "Bukit Panjang" as a general area. Cross-ref SCL-4
for whether the site should carry a UEN once one exists, and SCL-9 for whether it needs tracking from day one.

ACCEPTANCE: domain registered, site live with the five pages, no physical address published.`
},
{
  name: `SCL-4: Legal ${E} ACRA sole proprietorship and a business bank account, and when to do it`,
  info:
`${MARK}
SOURCE: scaling report sections 3.3 and 7 (question 7).

THE PLAN: Phase 2, 6-12 months - register a Sole Proprietorship with ACRA (~S$115), obtain a UEN, open a
business bank account. The report's own open question is the timing: register earlier to separate finances
from the first day, or wait until revenue is consistent enough to justify it.

★ WHY THE TIMING IS A REAL QUESTION AND NOT A FORMALITY. Registration is cheap and reversible-ish, but it
changes what the business is: a UEN becomes something listings and invoices should carry, the service
templates in legal/templates/ start being issued by an entity rather than a person, and the tax treatment of
the existing semi-informal sales changes. The report does not address any of that.

★ DELIVERABLE: a recorded decision with its reasoning, plus what changes operationally on the day of
registration - UEN on Carousell listings, invoicing, the quote and commercial-terms templates, and whether a
sole proprietorship is the right vehicle at this scale versus a Pte Ltd later.

⚠ CROSS-REF SCL-1. If hands-on repair is outside HBBS, the registration question changes shape entirely:
registering a business that is not permitted to do its main activity is worse than not registering.

NOTE: the report was written against a 7-month-old Carousell account; the live figure on 2026-09-27 is 8
months, and 14 orders.

ACCEPTANCE: a decision, its reasoning, and the operational checklist for the day it is filed.`
},
{
  name: `SCL-5: Channel ${E} GoListing and Lion City Assistant as secondary listing channels`,
  info:
`${MARK}
SOURCE: scaling report section 4.3.

THE PLAN: Carousell stays the primary channel; GoListing and Lion City Assistant are added as low-effort
secondary listings. The report notes Lion City Assistant has 50K+ downloads and suits the Chinese-speaking
demographic. Physical flyering is excluded (SCL-2).

★ THE OPERATIONAL COST IS THE REAL QUESTION, NOT THE SETUP. Every added channel creates a second place a
price can go stale. This business has already been bitten by exactly that: the Workbench carries a 2026-07-27
cost basis and listings whose prices were changed on Carousell and not in the record (LST-15), and two live
component listings with no cost basis at all (LST-17). Adding two more surfaces without deciding who updates
what, and when, multiplies a known failure rather than a hypothetical one.

DELIVERABLE: both accounts created; an explicit decision on whether listings are mirrored verbatim or repriced
per channel; and a written rule for which surface is authoritative when they disagree.

ACCEPTANCE: a price change has one recorded home and the other channels know where to read it from.`
},
{
  name: `SCL-6: Referral ${E} the S$10 / S$10 program, website-only, with a payout mechanism`,
  info:
`${MARK}
SOURCE: scaling report section 5.2.

THE PLAN: give S$10, get S$10. A past buyer receives a unique link or code; the new customer gets S$10 off;
the referrer receives S$10 by PayNow. Stated purpose is to drive traffic to the website and build a direct
customer database - explicitly not to move units.

★ CHECK THE ARITHMETIC AGAINST THE ACTUAL MARGINS BEFORE COMMITTING, BECAUSE ON THIS CATALOGUE IT IS LARGE.
Measured 2026-09-27: the remaining five PCs hold S$99.50 of margin between them, and individually the 24GB RX
580 carries S$22 and the 16GB RX 580 carries S$55. A S$10 discount on the S$22 machine is 45% of the profit,
and it is also 45% of the profit on a machine that has been unsold for a month. A referral that fires twice
on that unit loses money on the sale.

DELIVERABLE: a mechanism that cannot be gamed (one code per buyer, one redemption per order, no self-referral),
a decision on which machines the discount may apply to - the report's own framing suggests it belongs on the
higher-margin custom builds rather than the clearance stock - and a written payout method and record.

ACCEPTANCE: the referral cannot be applied to a machine whose margin is smaller than the payout.`
},
{
  name: `SCL-7: Content ${E} TikTok 3-4 posts a week, filmed by the owner and run by a friend`,
  info:
`${MARK}
SOURCE: scaling report section 4.2, including the hard constraint.

★ THE CONSTRAINT IS THE DESIGN. The owner dislikes social media. The report's shape therefore is: he films
behind-the-scenes material - cleaning, testing, cable management, before/after - and a friend manages the
account, posts, and replies to comments. Cadence 3-4 videos per week, focused on satisfying before/after
transformations, with the goal of driving traffic to the website and Carousell and explicitly NOT to become an
influencer.

★ THE HONEST RISK, WHICH THE REPORT NAMES AND THEN SETS ASIDE: this is the only item in the whole plan that
depends on someone else's sustained effort. Every other task here is work the owner controls. SCL-8 is the
same shape of dependency for storage and transport, which makes the pair worth deciding together - if the same
friend is doing both, the plan has a single point of failure with no contract behind it.

DELIVERABLE: a minimum viable handoff - what gets filmed, where it lands, who edits and posts, and how long a
clip can sit before it is stale - plus a decision on whether the account is branded or personal.

ACCEPTANCE: material can go from bench to posted without the owner logging into the platform.`
},
{
  name: `SCL-8: Ops ${E} contractor terms for friends and family doing storage and transport`,
  info:
`${MARK}
SOURCE: scaling report section 3.2 and question 2.

THE MODEL: friends and family act as independent contractors for logistics - storage and transport - paid per
item or per trip, explicitly NOT employees, because HBBS prohibits employees who do not live in the flat.
The owner holds the central inventory; each helper keeps small quantities at home. The report flags the need
for a simple contract template and does not supply one.

★ WHAT THE AGREEMENT HAS TO SETTLE, in order of how much it costs to get wrong:
  (a) That no employment relationship is created - which is both an HBBS condition and a tax question.
  (b) Who bears the loss when something is damaged in transit. This is the same exposure already
      unaddressed on the listings themselves (LST-11): the warranty promises cover for "damage caused by
      shipping" while the delivery option used is untracked and excluded by the platform. Adding a second
      layer of unpaid volunteers' cars to that chain multiplies it.
  (c) Per-item and per-trip rates, and how they are evidenced and paid.

⚠ CROSS-REF SCL-1 (b). If stock at a non-resident's home is a second premises, this whole model is the
question, not the answer.

ACCEPTANCE: a short written agreement per helper covering scope, rates, damage liability and the no-employment
statement.`
},
{
  name: `SCL-9: Analytics ${E} per-channel conversion, so the roadmap can be judged`,
  info:
`${MARK}
SOURCE: scaling report section 7, question 4.

THE QUESTION: how to measure which channel - Carousell, TikTok, the website, referrals - drives an actual sale.
Candidates in the report: UTM parameters, unique codes, or simply asking each buyer how they heard about the
seller.

★ THE BASELINE IS EMPTY AND THAT IS THE CHEAPEST PART OF THIS TASK TO FIX. Measured 2026-09-27:
  - Six recorded sales in LedgerEntries, S$1,135 received against S$1,200 of asking prices - so the account
    clears roughly 94.6% of ask. That is the one solid conversion number the business has.
  - Listings.dateSold is NULL on ALL SIX sold rows, so there is no days-to-sell figure at all: no velocity, no
    seasonality, no way to tell whether a markdown worked.
  - Listings.likes and Listings.wantCount are NULL on ALL 15 rows, so the engagement snapshot the schema
    provides for exactly this purpose has never been captured once.
So before any channel attribution exists, the two cheapest measurements - set dateSold on the day, and read
likes/want when checking a listing - are both unused. A markdown campaign is currently unmeasurable by
construction.

DELIVERABLE: one tracking method chosen and applied from the first sale, PLUS dateSold and likes actually
being recorded, since without those no channel comparison can be interpreted anyway.

ACCEPTANCE: for any sale after this task, the record can answer which channel, how many days, and how much
against ask.`
},
{
  name: `SCL-10: Decisions ${E} the scaling report's seven open questions, resolved or explicitly parked`,
  info:
`${MARK}
The scaling report ends with seven open questions and states them as questions rather than conclusions. Four
of them already have their own task here; the point of this row is that the other three get an answer too, and
that "we decided not to" has somewhere to live.

  (1) Website payment integration - Stripe/PayPal fees against Carousell Buyer Protection. Website-only;
      blocked behind SCL-3. Decision needed: does the site take money at all.
  (2) Independent contractor agreements for storage/transport -> SCL-8.
  (3) TikTok content workflow without the owner on camera -> SCL-7.
  (4) Conversion tracking -> SCL-9.
  (5) Scaling inventory: how to fund buying used parts as sales grow - reinvest profit or take a small loan.
      NOT YET ITS OWN TASK. This is the one question with an arithmetic answer available: the stock sheet
      values on-hand inventory at S$24,515.50 across 94 rows and 118 units (recorded cost, as at 2026-07-27),
      while six months of sales have returned S$1,135. The gap between those two numbers is the real
      constraint on scaling, and it is larger than the question implies.
  (6) Legal risk of distributed inventory under HBBS -> SCL-1.
  (7) ACRA timing against opening a business bank account -> SCL-4.

★ WHY THIS ROW EXISTS AT ALL: the dashboard has no other place for a decision that was taken deliberately in
the negative. Without it, an unanswerable question looks identical to an unanswered one, and it gets
re-litigated every time the plan is revisited.

ACCEPTANCE: each of the seven has a recorded answer, an owner, or an explicit park with its reason.`
}
];

// ---------------------------------------------------------------------------

async function alreadyDone(pool) {
  const r = await pool.request()
    .input('mark', `%${MARK}%`)
    .query(`SELECT COUNT(*) AS n FROM Tasks WHERE info LIKE @mark`);
  return Number(r.recordset[0].n);
}

async function nextSort(pool, edictId) {
  const r = await pool.request().input('e', edictId)
    .query(`SELECT ISNULL(MAX(sortOrder), 0) AS m FROM Tasks WHERE edictId = @e`);
  return Number(r.recordset[0].m) + 1;
}

async function ensureEdict(pool) {
  const found = await pool.request().input('n', SCALING_NAME)
    .query(`SELECT id FROM Edicts WHERE name = @n`);
  if (found.recordset.length) {
    console.log(`  edict "${SCALING_NAME}" exists: #${found.recordset[0].id}`);
    return found.recordset[0].id;
  }
  if (!YES) {
    console.log(`  edict "${SCALING_NAME}" WOULD be created (state 2 = published, priority ${PRIORITY})`);
    return null;
  }
  const ins = await pool.request()
    .input('name', SCALING_NAME)
    .input('plannedStart', new Date())
    .input('plannedEnd', null)
    .input('info', SCALING_INFO)
    .input('priority', PRIORITY)
    .input('state', 2)   // edicts: 2 = published/active, matching "Listing Workbench"
    .query(`INSERT INTO Edicts (name, plannedStart, plannedEnd, info, priority, state, completedAt)
            OUTPUT INSERTED.id AS id
            VALUES (@name, @plannedStart, @plannedEnd, @info, @priority, @state, NULL)`);
  return ins.recordset[0].id;
}

async function insertSet(pool, edictId, rows, label) {
  let sort = await nextSort(pool, edictId);
  console.log(`\n--- ${label}: ${rows.length} rows on edict ${edictId}, sortOrder from ${sort}`);
  const ids = [];
  for (const r of rows) {
    console.log(`  [${sort}] ${r.name.slice(0, 78)}  (info ${r.info.length} chars)`);
    if (!YES) { sort += 1; continue; }
    const ins = await pool.request()
      .input('name', r.name)
      .input('info', r.info)
      .input('plannedStart', new Date())   // JS Date -> written as UTC wall-clock, so active computes to 1
      .input('sortOrder', sort)
      .input('edictId', edictId)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id AS id
              VALUES (@name, @info, @plannedStart, ${PRIORITY}, ${OPEN}, @edictId, @sortOrder, SYSUTCDATETIME())`);
    ids.push(ins.recordset[0].id);
    sort += 1;
  }
  return ids;
}

async function verify(pool, ids) {
  if (!ids.length) return;
  const list = ids.join(',');
  const back = await pool.request().query(
    `SELECT id, sortOrder, state, priority, active, LEN(CAST(info AS nvarchar(max))) AS info_len, name
     FROM Tasks WHERE id IN (${list}) ORDER BY sortOrder`);
  console.log('\n--- read-back');
  for (const r of back.recordset)
    console.log(`  #${r.id} sort=${r.sortOrder} state=${r.state} pri=${r.priority} active=${r.active} info=${r.info_len}  ${String(r.name).slice(0, 70)}`);
  const bad = await pool.request().query(
    `SELECT COUNT(*) AS n FROM Tasks WHERE id IN (${list})
       AND (name LIKE N'%' + NCHAR(226) + N'%' OR info LIKE N'%' + NCHAR(226) + N'%')`);
  console.log(`  mojibake check (U+00E2 present in name or info): ${bad.recordset[0].n} row(s)`);
  const dash = await pool.request().query(
    `SELECT COUNT(*) AS n FROM Tasks WHERE id IN (${list}) AND name LIKE N'%' + NCHAR(8212) + N'%'`);
  console.log(`  names carrying a real em dash U+2014: ${dash.recordset[0].n} (expected ${ids.length})`);
  const inact = await pool.request().query(`SELECT COUNT(*) AS n FROM Tasks WHERE id IN (${list}) AND active = 0`);
  console.log(`  rows with active = 0: ${inact.recordset[0].n}`);
}

(async () => {
  const pool = await getPool();

  const done = await alreadyDone(pool);
  if (done) {
    console.log(`⚠ ${done} row(s) already carry the marker "${MARK}" — nothing to do.`);
    await pool.close();
    return;
  }

  const lstMax = await pool.request().query(`SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks WHERE edictId = ${LST_EDICT}`);
  console.log(`edict ${LST_EDICT} ("Listing Workbench") max sortOrder = ${lstMax.recordset[0].m}`);

  const scalingId = await ensureEdict(pool);
  const scalingTarget = scalingId ?? '(new)';

  const lstIds = await insertSet(pool, LST_EDICT, LST, 'LST-9..LST-18');
  // Dry run: print the SCL rows too, projecting sortOrder from 1 for a not-yet-created edict.
  const sclIds = await insertSet(pool, Number(scalingId ?? 0), SCL, 'SCL-1..SCL-10');

  if (!YES) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    await pool.close();
    return;
  }

  await verify(pool, [...lstIds, ...sclIds]);
  console.log(`\n✔ edict ${scalingTarget}: ${SCL.length} tasks · edict ${LST_EDICT}: ${LST.length} tasks`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
