# Provider compatibility register

This register reports integration state, not worldwide legality or a promise
that an upstream service will remain available. Check it during each release
candidate and after any upstream or terms change.

| Integration | Configuration and data flow | Current compatibility | Evidence | Owner | Next review |
| --- | --- | --- | --- | --- | --- |
| Standard Ebooks | Public OPDS request; selected metadata flows to operator instance. | Code retained; live check pending. | `RELEASE_TEST_MATRIX.md` PROV-01 | Provider maintainer | Before v1.1.0 tag |
| Project Gutenberg | Public catalogue/request; rights metadata retained when supplied. | Code retained; live check pending. | `RELEASE_TEST_MATRIX.md` PROV-01 | Provider maintainer | Before v1.1.0 tag |
| Internet Archive | Public catalogue/request; acknowledgement applies where rights metadata is incomplete. | Code retained; live check pending. | `RELEASE_TEST_MATRIX.md` PROV-01 | Provider maintainer | Before v1.1.0 tag |
| Generic OPDS | Operator-configured endpoint and credentials. | Code retained; representative server check pending. | `RELEASE_TEST_MATRIX.md` PROV-01 | Provider maintainer | Before v1.1.0 tag |
| Anna's Archive | Optional operator configuration; requests and any credential go to upstream. | Code retained; counsel and approved live check pending. | `RELEASE_TEST_MATRIX.md` PROV-02 | Provider and project owners | Before v1.1.0 tag |
| Z-Library | Anonymous search or operator account download; credentials remain instance-local. | Code retained; counsel and approved live check pending. | `RELEASE_TEST_MATRIX.md` PROV-02 | Provider and project owners | Before v1.1.0 tag |
| Microsoft Edge TTS | Narration text goes to Microsoft's consumer endpoint. | Retained; live compatibility and terms review pending. | `RELEASE_TEST_MATRIX.md` TTS-01 | TTS maintainer | Before v1.1.0 tag |
| Local Kokoro | Local container; model download may require first-run external egress. | Retained; current image evidence pending. | `RELEASE_TEST_MATRIX.md` TTS-02 | TTS maintainer | Before v1.1.0 tag |
| Local Chatterbox | Local container; model download may require first-run external egress. | Retained; current image evidence pending. | `RELEASE_TEST_MATRIX.md` TTS-03 | TTS maintainer | Before v1.1.0 tag |
| Azure Speech | Proposed optional cloud path; text would go to the selected Azure region. | Not implemented. | `AZURE_SPEECH_PROVIDER_PROPOSAL.md` | Provider maintainer | On implementation proposal |

An outage is evidence, not a reason to silently delete an integration. Record
the date, upstream symptom, affected versions, safe workaround, and next
review in the candidate report or a follow-up issue.
