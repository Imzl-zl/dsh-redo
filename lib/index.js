// src/index.ts
import { randomUUID } from "node:crypto";
var name = "redo";
var inject = ["agents", "commands"];
var REDO_PREFIX = "redo:";
var REDO_REQUEST_ID = /^(\d+):/;
var ARM_TTL_MS = 5 * 60 * 1e3;
var USAGE = "/redo <message seq>|off";
var REFUSAL_THROWN = {
  missing: "is no longer part of the active context",
  head: "is the protected session head",
  "not-user": "is not a human user message"
};
var REFUSAL_SHOWN = {
  missing: "that message is no longer part of the conversation context",
  head: "the first message of a session cannot be rewritten",
  "not-user": "only a message you sent can be rewritten"
};
function isHumanPrompt(source) {
  if (typeof source !== "object" || source === null) return false;
  const record = source;
  return record.kind === "user" && typeof record.rpcId === "string";
}
function redoTarget(source) {
  if (typeof source !== "object" || source === null) return void 0;
  const record = source;
  if (record.kind !== "user" || typeof record.rpcId !== "string") return void 0;
  if (!record.rpcId.startsWith(REDO_PREFIX)) return void 0;
  const match = REDO_REQUEST_ID.exec(record.rpcId.slice(REDO_PREFIX.length));
  if (match === null) return void 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function refusalOf(agent, target) {
  const session = agent.session;
  const nodes = [...session.surface.nodes];
  const start = nodes.indexOf(target);
  if (start < 0) return "missing";
  if (start === 0) return "head";
  const event = session.eventAt(target);
  if (event?.type !== "user/message" || event.data.source.kind !== "user") return "not-user";
  return void 0;
}
function rewind(agent, target, turn, step) {
  const why = refusalOf(agent, target);
  if (why !== void 0) throw new Error(`redo: message ${target} ${REFUSAL_THROWN[why]}`);
  const nodes = [...agent.session.surface.nodes];
  const shadowed = nodes.slice(nodes.indexOf(target));
  agent.session.append("system/message", {
    turn,
    step,
    message: {
      // A fresh identity keeps the empty node unique; it never reaches a provider.
      id: randomUUID(),
      role: "system",
      source: { kind: "system-prompt" },
      content: []
    }
  }, {
    surfaceOp: { op: "replace", startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
    sourceEventSeqs: shadowed
  });
}
function parseArmTarget(rawInput) {
  const trimmed = rawInput.trim();
  if (trimmed === "off") return "off";
  if (!/^\d+$/u.test(trimmed)) return void 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function apply(ctx) {
  const plans = /* @__PURE__ */ new WeakMap();
  const armed = /* @__PURE__ */ new WeakMap();
  ctx.effect(() => ctx.commands.register({
    name: "redo",
    description: "Rewrite the conversation from an earlier message: the next message you send replaces it",
    input: { hint: "<message seq>|off" },
    handler: (invocation) => {
      const parsed = parseArmTarget(invocation.rawInput);
      if (parsed === void 0) return { kind: "error", text: `redo: usage ${USAGE}` };
      if (parsed === "off") {
        armed.delete(invocation.agent);
        return { kind: "success" };
      }
      const why = refusalOf(invocation.agent, parsed);
      if (why !== void 0) return { kind: "error", text: `redo: ${REFUSAL_SHOWN[why]}` };
      armed.set(invocation.agent, { target: parsed, at: Date.now() });
      return { kind: "success" };
    }
  }), "dsh-redo: redo command");
  ctx.on("agent/pre-step", async ({ agent, messages, turn, step }, next) => {
    const explicit = messages.map((message) => redoTarget(message.source)).find((target) => target !== void 0);
    if (explicit !== void 0) {
      armed.delete(agent);
      plans.set(agent, { turn, step, target: explicit });
      return next();
    }
    const pending = armed.get(agent);
    if (pending !== void 0 && messages.some((message) => isHumanPrompt(message.source))) {
      armed.delete(agent);
      if (Date.now() - pending.at <= ARM_TTL_MS) plans.set(agent, { turn, step, target: pending.target });
    }
    return next();
  });
  ctx.on("agent/request", async ({ agent, turn, step }, next) => {
    const plan = plans.get(agent);
    if (plan !== void 0 && plan.turn === turn && plan.step === step) {
      plans.delete(agent);
      rewind(agent, plan.target, turn, step);
    }
    return next();
  });
  ctx.on("agent/disposed", ({ agent }) => {
    plans.delete(agent);
    armed.delete(agent);
  });
}
export {
  apply,
  inject,
  name
};
