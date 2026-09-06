# Telegram turn-boundary queueing

## Intent

Preserve inbound Telegram messages that arrive while an embedded agent run is already in progress, but inject them at the next turn boundary instead of waiting for the whole multi-turn run to finish.

This patch exists because run-scoped queueing feels broken in chat.
A user can send a correction or follow-up during a live run and still receive a stale reply from the previous context.
The desired behavior is narrower: queue only during the current assistant turn inference, then append the queued inbound message to context before the next assistant turn starts.

## What this patch changes

- Prefer steering queued inbound text into the live embedded session when the current run is active and streaming.
  - This aims at the next turn boundary.
- Keep the existing followup queue as fallback when steering is not available.
- Add a regression test for the active embedded run path.

## Files

- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`

## Priority during rebases

1. Preserve turn-boundary delivery over run-end delivery.
2. Preserve correctness for embedded streaming sessions.
3. Preserve fallback behavior when steering is unavailable.
4. Preserve the regression test or replace it with equivalent coverage.

## How to reason about conflicts

- If upstream refactors queue policy names, keep the semantic rule:
  - active embedded streaming runs should prefer next-turn injection instead of full followup deferral.
- If upstream moves steering out of `agent-runner.ts`, reapply the behavior at the layer that still has both facts available:
  - whether the run is currently active and streaming
  - whether the inbound message would otherwise be queued until after the run
- If upstream changes `queueEmbeddedPiMessage`, verify whether it still steers into the live session transcript before the next assistant turn.
  - If yes, keep using it.
  - If no, reimplement that next-turn injection path explicitly.

## When to give up on this branch

Give up on this patch if upstream lands first-class turn-boundary inbound queueing for embedded chat sessions and it is clearly more correct than this local behavior.
In that case, drop the patch and adopt upstream.

Also give up if the surrounding runner architecture changes so much that preserving this patch becomes riskier than reimplementing the behavior from scratch.

## When to reimplement from scratch

Reimplement instead of preserving the exact diff when:

- the run/queue boundary is redesigned upstream
- steering becomes deprecated or semantically different
- inbound Telegram queueing moves to a channel-specific layer
- the regression test no longer matches the new execution model

The core requirement to keep is simple:
queued inbound user messages should become visible to the agent after the current turn finishes, not only after the entire run finishes.
