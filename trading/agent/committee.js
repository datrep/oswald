// trading/agent/committee.js — TRD-55 (2026-09-14): WHEN IS THE COMMITTEE CONVENED?
//
// Pure on purpose: `aggregator.js` pulls in the store and the connectors, so a
// unit test cannot require it. The rule lives out here where it can be pinned.
//
// THE RULE: a chair vote is a VETO ON A PROPOSAL. If there is no proposal, there
// is nothing to veto, and the answer is already written in the contract —
// `chair.js` says "If no proposal is presented, vote no." Convening the committee
// anyway buys a foreordained answer at the price of a full bundle per chair.
//
// MEASURED 2026-09-14 (the reason this is not a guess):
//   * 177 chair votes were cast on wakes with NO proposal. All 177 were
//     "no" or "abstain". NOT ONE was "yes".
//   * Those 57 no-proposal deliberation rounds cost ~628,910 input tokens:
//     44% of the desk's entire LLM input bill for a decision already made.
//   * By contrast, the position-review path costs ~1,374 input tokens per
//     prompt against ~11,253 for a deliberation round — 8.2x cheaper, and it
//     asks a question that has an answer.
//
// WHAT IS NOT LOST: position oversight. A wake with open positions and no
// proposal used to reach the chairs and return "deliberation declined" with
// `action: 'none'` hardcoded — it could never close anything. `review.js`
// reviews every open position on its own loop and logs real hold/close
// verdicts, so the desk's position oversight never depended on this round.
//
// The inverted-question defect that made this visible is logged separately
// (promptBuilder asks "whether to stay flat" while chairSummary reads yes as
// approve) — removing the round also removes the only path that reached it.
'use strict';

const NO_PROPOSAL_FLAT = 'flat_no_proposal';
const NO_PROPOSAL_POSITIONS = 'positions_open_no_proposal';

// Returns { convene, count, reason }. A caller must not call the chairs when
// convene is false, and must record the reason rather than staying silent.
function committeePlan({ proposals = [], hasAgentPositions = false } = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  if (list.length) return { convene: true, count: list.length, reason: 'proposals_to_vote_on' };
  return {
    convene: false,
    count: 0,
    reason: hasAgentPositions ? NO_PROPOSAL_POSITIONS : NO_PROPOSAL_FLAT,
  };
}

// The human-readable half of the same decision, so the two cannot drift. An
// explicit blocker (kill/session/pause) outranks the no-proposal explanation
// because it is the reason the desk is standing down.
function skipReasonText(reason, { blocked = null } = {}) {
  if (blocked) return blocked;
  if (reason === NO_PROPOSAL_POSITIONS) {
    return 'positions open, no proposal - committee not convened (position oversight runs in the review loop)';
  }
  return 'no_signal (flat, no proposal - chairs skipped)';
}

module.exports = {
  committeePlan,
  skipReasonText,
  NO_PROPOSAL_FLAT,
  NO_PROPOSAL_POSITIONS,
};
