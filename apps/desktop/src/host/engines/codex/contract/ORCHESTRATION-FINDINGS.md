# Orchestration contract findings

The supported manifest recommends 0.166.0; no such executable was found in the system PATH or the inspected system and probe directories. The available `/opt/homebrew/bin/codex` reports 0.144.3. All executions used a separate empty HOME, CODEX_HOME, workspace and user-data directory, with no inference. The lower reference fixture is 0.144.3; its experimental feature subset was generated with `generate-json-schema --experimental` after checking help. The ordinary pinned schema intentionally omits experimental fields.

| Mechanism | Schema | Configuration / no-inference observation (0.144.3) | Inference |
| --- | --- | --- | --- |
| Start/resume developer instructions and config | Both request shapes declare them | Start accepted; resume of the same newly started idle thread failed `no rollout found`; effective instructions and config are not echoed | Not tested |
| Reversible ON/OFF on same thread, history | Resume accepts threadId | First resume failed before ON, OFF and read; no conclusion about a thread with existing turns | Not tested |
| Dynamic Agent declarations | Experimental start declares dynamicTools and call types; experimental resume **does not declare dynamicTools** | Start accepted a declaration; acceptance does not prove it was installed. Resume declaration and retention unverified | Not tested |
| Ambient MCP suppression and restoration | Config is an open object; this does not validate keys | `config/read` returned both seeded ambient server names, multi_agent and layers. Per-name `enabled=false` and restoration were sent only in the failed resume, so neither effect is established | Not tested |
| Native alternative delegation | Feature key is not established by schema | Seeded `features.multi_agent=true` appeared in config/read; runtime availability and override to false unverified | Not tested |
| Read-only and never | Start/resume allow sandbox and approval policy; turn uses a separate sandboxPolicy | Start echoed `readOnly`, `networkAccess=false`, `never` and reviewer `user`; no turn was started | No write or escalation test |
| config/read and overrides | cwd and includeLayers are declared | Ambient fixture values and layers visible; thread overrides were not established and config/read has no thread identifier | Not tested |

**Gate:** Do not build the dependent mode transition on this evidence. The empty-thread resume failed, and the lower experimental schema lacks resume dynamicTools. A populated thread, effective instructions, repeat declarations, named MCP disabling and restoration, and recommended 0.166.0 remain unverified. Evaluate a server-supported reconfiguration mechanism or an explicitly designed new-thread/history migration with the owner; neither is asserted to preserve developer priority or history here. The inference phase requires a separately isolated authenticated profile and sentinel tests.
