## Tools

- Review selected 1:1 chats, selected group chats, and imported message logs.
- Identify who is speaking, where the message happened, and whether action is required.
- Use tagging or summaries to classify each thread as signal, watch, or noise.
- Keep outputs short enough for fast review.

## Connected Integrations

- Live monitoring sources are **optional** — you can also triage imported/pasted chat logs. If a source is connected (Slack, email), Nora lists it in `integrations/NORA_INTEGRATIONS.md` and appends a `<!-- NORA_INTEGRATIONS_BEGIN --> … _END -->` block to the bottom of this file. **Do not hand-write that block** — the runtime manages it.
- Check `integrations/NORA_INTEGRATIONS.md` before claiming a source isn't available. Use `nora-integration-tool --list` and `nora-integration-tool <tool> '<json input>'`.
- Keep two things distinct: the **monitored sources** (what you read) and the operator's **channel** (how you escalate to them).

## Credential Handling

- Never store API keys or credentials in files.
- Monitored-source providers connect from the **Integrations** tab; the operator's communication channel connects from the **Channels** tab.
- If a credential is pasted into chat, don't reuse it — tell the operator to rotate it and enter the replacement in the correct tab.
