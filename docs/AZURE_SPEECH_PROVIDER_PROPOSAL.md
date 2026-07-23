# Azure Speech provider proposal

Status: proposed; not implemented and not a v1.1.0 release prerequisite
Owner: provider maintainer and project owner
Decision required: approve implementation, terms review, and a live-account test before advertising support

## Purpose

Add Azure AI Speech text-to-speech as an optional cloud narrator. It complements
Microsoft Edge, Kokoro, and Chatterbox; it must not replace or disable any of
them. An operator who does not configure Azure sees no Azure request.

## Proposed contract

Configuration uses `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY`, and an explicit
`AZURE_SPEECH_ENABLED=true` acknowledgement. Keep the key in the operator's
secret store or environment, never in browser storage, exported diagnostics, or
logs. The server sends SSML and the selected voice to the region-specific
Azure Speech endpoint and stores only the resulting audio in the existing
operator-controlled cache.

The provider should fetch the region's voice list at configuration test time,
cache it for a bounded period, and show its region, last successful check, and
failure state. Voice selection must use the returned Azure voice name; it must
not assume that an Edge voice exists in Azure. A disabled, unconfigured, quota
limited, or unavailable Azure provider must leave uploads and every other
narration engine usable.

Use the documented REST route for ordinary, chunked synthesis:
`https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`. Send
`application/ssml+xml`, an explicit `X-Microsoft-OutputFormat`, and a concise
application `User-Agent`. Start with `audio-24khz-160kbitrate-mono-mp3` only
after confirming that it fits the existing cache and Range-response pipeline.
Azure documents a ten-minute limit for a REST synthesis response, so existing
chapter chunking remains mandatory. The endpoint, supported voice list, output
formats, and regional availability must be rechecked during implementation.

Azure accepts a resource key header or a bearer token. The first implementation
should use the resource key only on the server. A follow-up may support Entra
identity or short-lived token exchange when the deployment model can protect
that credential. Azure keys are regional; a mismatched key and endpoint fails
authentication. [Azure REST reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)

## Privacy, cost, and safety requirements

Azure receives the text submitted for narration, the selected voice, request
metadata, and the operator's credential. It is an external processor, not a
local engine. The configuration UI and self-hosting guide must say this before
enablement, name the selected region, link Azure's current terms, pricing, and
privacy materials, and state that charges, quotas, retention, and availability
belong to the operator's Azure account. Azure says Speech processes data in the
region of the Speech resource; that statement does not replace an operator's
own privacy or jurisdictional assessment. [Azure region guidance](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions)

Do not implement Azure Custom Voice, Personal Voice, voice enrollment, or
voice-reference upload in this provider proposal. Those capabilities require a
separate design, explicit authority evidence, product terms review, and a
release-matrix addition. Azure itself assigns customers responsibility for
permissions to submitted content and voice-related data. [Azure TTS privacy and security guidance](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security)

## Acceptance gates

| Gate | Evidence | Owner | Status |
| --- | --- | --- | --- |
| Current terms, pricing, and supported-region review | Dated links and reviewer decision | Project owner | Blocked — not reviewed |
| Credential handling and redaction review | Threat-model update and tests | Security maintainer | Blocked — not implemented |
| Voice-list, synthesis, retry, timeout, and quota handling | Unit tests plus a disposable-account run | Provider maintainer | Blocked — not implemented |
| MP3 cache, Range playback, iOS playback, and engine isolation | Release-matrix evidence | TTS and QA owners | Blocked — not implemented |
| Opt-in disclosure and configuration reset/delete behavior | UI and documentation review | Project owner | Blocked — not implemented |

No gate is satisfied by this proposal. Add Azure to the public compatibility
table only after every gate passes.
