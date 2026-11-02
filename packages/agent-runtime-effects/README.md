# `@marshal/agent-runtime-effects`

Harness-neutral native effects, durable background jobs, and scheduling for the
Marshal runtime. The package depends only on `agent-runtime-core`; adapters
supply effect callbacks and job handlers.

## Agent-facing capabilities

Register `createRuntimeEffectsProvider({ effects, jobs })` with any
`RuntimeKernel`. Agents then discover and invoke these through the same
`runtime_search` / `runtime_exec` adapter surface as every other capability:

- `runtime.effects.execute`
- `runtime.jobs.start`
- `runtime.jobs.status`
- `runtime.jobs.cancel`
- `runtime.jobs.resume`
- `runtime.schedules.create`
- `runtime.schedules.get`
- `runtime.schedules.list`
- `runtime.schedules.update`
- `runtime.schedules.pause`
- `runtime.schedules.resume`
- `runtime.schedules.cancel`

```ts
const effects = new EffectDispatcher({
  replay: new BoundedFileEffectReplayStore({ rootDirectory: effectState }),
  handler: harnessEffectAdapter, // optional; absent effects return unsupported
  approvalVerifier: harnessApprovalVerifier, // atomic verify-and-consume trust port
});

const jobs = new BackgroundJobManager({
  store: new BoundedFileJobStore({ rootDirectory: jobState }),
  handlers: portableJobHandlers,
});

kernel.register(createRuntimeEffectsProvider({ effects, jobs }));
kernel.register(createRuntimeSchedulingProvider({ effects }));
```

## Effects

Every effect has a caller-supplied idempotency key bound to its kind/input
digest. Completed responses are durably replayed with a new receipt referencing
the original receipt. Concurrent calls sharing one principal, scope, and key are
serialized through a durable execution claim before dispatch, including across
processes sharing the replay root, and reusing a key for different input fails. Adapter callbacks
return one explicit envelope: `success`, `unsupported`, `approval_required`,
`failed`, or `cancelled`. Approval requirements and unsupported results are not
cached because no native action occurred.

Caller-provided approval objects are inert evidence. If an effect request carries
one, `EffectDispatcher` fails closed unless the harness supplies a
`RuntimeEffectApprovalVerifier`. Its `verifyAndConsume` operation must atomically
authenticate and consume the grant once; Marshal binds the verification request
to principal, complete invocation scope, effect kind, request digest,
idempotency key, effect ID, and expiry before the native handler can run. The
verifier's consumption timestamp must be no later than the runtime's current
time and strictly earlier than its future expiry.

The file replay store renews execution leases and recovers abandoned claims.
Its transaction locks carry random owner tokens and live heartbeats. Stale
recovery uses token-derived, single-winner quarantines retained through the
contender timeout and then cleaned, so an observation of an old lock cannot
remove a fresh owner. Acquisition deadlines apply to every recovery path. This
prevents simultaneous dispatch across cooperative host processes. No local
claim protocol can prove that a remote/native action did not complete immediately
before a process crash, so adapters must forward and enforce Marshal's downstream
idempotency key when the native system supports mutation.

## Background jobs

`start` immediately returns an opaque durable handle. `status`, `cancel`, and
`resume` enforce the original principal and full runtime scope. Storage is
bounded by record size, total bytes, and record count; only terminal records are
eligible for eviction.

A handler can finish with data or pause with a JSON checkpoint. Resume always
calls the currently registered `resume(job, context, control)` callback. The
runtime never serializes closures, stack frames, promises, or JavaScript
continuations. After process loss, a host may explicitly resume an orphaned
`running` record through that callback.

## Scheduling

Scheduling is a distinct capability surface, not a workflow abstraction. The
portable layer validates bounded one-time, interval, and cron timing plus an
adapter-owned task kind and JSON input. It then dispatches fixed
`runtime.schedule.*` native effects. Create/update/pause/resume/cancel are
durably idempotent; get/list bypass replay so status stays fresh.

The fixed scheduling kinds are reserved for the typed `runtime.schedules.*`
capabilities. `runtime.effects.execute` rejects them, so a broad generic-effect
grant cannot bypass the schedule operation's specific permission.

Adapters may implement any supported subset through `RuntimeEffectHandler` and
must return `unsupported` for unavailable host behavior. The host clock and
native schedule remain authoritative. The browser never receives executable
source or arbitrary file authority. Schedule reads are granted by the default
host profile; every mutation remains opt-in or approval-gated. The adapter must
authorize and resolve every schedule against the exact principal and complete
invocation scope it receives; a `scheduleId` must never be treated as globally
authoritative.

### Runtime-owned scheduler

A host without its own clock can let the runtime own it. `RuntimeScheduleService`
is a `RuntimeEffectHandler` for the seven `runtime.schedule.*` kinds. It keeps
schedules in a `FileScheduleStore` (one JSON file per schedule, atomic writes,
a lock shared by every process on the root) and fires them from a loop the host
starts with `service.start()`. `tick(now)` is the unit the loop calls.

```ts
const scheduler = new RuntimeScheduleService({
  store: new FileScheduleStore({ rootDirectory: join(stateRoot, 'schedules') }),
  runners: { [AGENT_WAKE_TASK_KIND]: createAgentWakeRunner(hostWakePort) },
});
createRuntimeBuiltinsSource({ scheduler }); // or: new EffectDispatcher({ handler: scheduler })
scheduler.start();
```

- An agent calls `runtime.schedules.create` with `timing` (`once`, `interval`, or
  five-field `cron` with an IANA `timezone`) and `task: {kind: 'agent.wake',
  input: {target: {sessionId | agentId}, message}}`.
- The wake reaches the agent through the host's `RuntimeWakePort`. The runtime
  never runs what an agent names. `createCommandWakePort` runs a host-chosen
  command with the wake on stdin and in `MARSHAL_WAKE_*` variables;
  `createHttpWakePort` posts the wake to a host-chosen URL.
- Fires are at least once. A claim lease stops two processes that share a root
  from firing one slot. A recurring schedule that missed slots fires once, then
  moves to its next future slot. A failed fire retries with backoff, then a
  one-off schedule ends `failed` and a recurring one moves on. A host that starts
  late fires overdue one-off schedules at once.
- A schedule belongs to the creating principal and full scope. Another scope
  cannot read, change, or cancel it. Limits: 100 live schedules per owner, one
  minute minimum interval, one year maximum lead time.
- A process that only creates schedules (a per-session `marshal-runtime-mcp`)
  passes `acceptedTaskKinds` and no runners; `marshal-runtime-scheduler` runs the
  loop over the same root.

## Adapter conformance

An adapter integration should verify that:

1. unsupported effects return an envelope instead of throwing;
2. approvals fail closed without an atomic harness verifier and are bound to the
   complete effect authority tuple;
3. simultaneous dispatchers sharing a replay root execute one mutation once;
4. all effect/job capabilities and seven scheduling capabilities appear in
   runtime discovery;
5. job handles survive manager reconstruction;
6. cancellation reaches the handler signal;
7. resume consumes only persisted data plus a registered callback;
8. handles and schedules cannot be read or controlled from another scope;
9. schedule mutations replay by idempotency key while get/list always consult
   the adapter and unsupported hosts return a typed envelope.

The package test suite runs these requirements against fake adapters and the
normal `RuntimeKernel` provider path.
