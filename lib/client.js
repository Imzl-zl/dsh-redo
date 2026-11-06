window.__ModuleLoader__.load({
	id: "dsh-redo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  RedoUserMessage: () => RedoUserMessage,
  apply: () => apply,
  description: () => description,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/client/command-run.ts
function classifyCommandRun(run) {
  if (!run.ok) return { ok: false, code: "rejected", message: run.error.message };
  if (run.value === void 0) return { ok: false, code: "command" };
  if (run.value.result.kind === "error") return { ok: false, code: "rejected", message: run.value.result.text };
  return { ok: true };
}

// src/client/intervals.ts
function replaceRangeOf(op) {
  if (typeof op !== "object" || op === null) return void 0;
  const record = op;
  if (record.op !== "replace") return void 0;
  const { startSeq, endSeq } = record;
  if (typeof startSeq !== "number" || typeof endSeq !== "number") return void 0;
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return void 0;
  if (endSeq < startSeq) return void 0;
  return { from: startSeq, to: endSeq };
}
function covers(intervals, seq) {
  return intervals.some((interval) => seq >= interval.from && seq <= interval.to);
}
function deriveIntervals(events) {
  const intervals = [];
  for (const event of events) {
    const range = replaceRangeOf(event.surfaceOp);
    if (range !== void 0) intervals.push(range);
  }
  return intervals;
}
function turnOf(event) {
  if (event.type !== "turn/start" && event.type !== "turn/end") return void 0;
  const value = event.data?.turn;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
function deriveRetractionTurns(events) {
  const prompted = /* @__PURE__ */ new Set();
  const replaced = /* @__PURE__ */ new Set();
  let turn;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn = turnOf(event);
      continue;
    }
    if (event.type === "turn/end") {
      turn = void 0;
      continue;
    }
    if (turn === void 0) continue;
    if (event.type === "user/message") prompted.add(turn);
    else if (replaceRangeOf(event.surfaceOp) !== void 0) replaced.add(turn);
  }
  return [...replaced].filter((value) => !prompted.has(value));
}

// src/client/locales.ts
var zh = {
  "action.edit": "\u7F16\u8F91\u91CD\u53D1",
  "action.editHint": "\u70B9\u4E00\u4E0B\u5C31\u628A\u8FD9\u6761\u6D88\u606F\u64A4\u56DE\u8F93\u5165\u6846\uFF1B\u53D1\u9001\u540E\u6309\u6539\u540E\u7684\u5185\u5BB9\u91CD\u65B0\u56DE\u7B54",
  "action.retry": "\u91CD\u65B0\u751F\u6210",
  "action.retryHint": "\u64A4\u6389\u8FD9\u6761\u6D88\u606F\u548C\u5B83\u4E4B\u540E\u7684\u5BF9\u8BDD\uFF0C\u7528\u540C\u6837\u7684\u5185\u5BB9\u91CD\u65B0\u56DE\u7B54",
  "action.unsupported": "\u5E26\u6587\u4EF6\u7684\u6D88\u606F\u6682\u4E0D\u652F\u6301\u7F16\u8F91\u6216\u91CD\u8BD5",
  "action.running": "\u56DE\u7B54\u751F\u6210\u4E2D\uFF0C\u5148\u505C\u6B62\u518D\u91CD\u53D1",
  "action.copy": "\u590D\u5236",
  "action.cancel": "\u53D6\u6D88\u91CD\u5199",
  "retract.pending": "\u8FD9\u6761\u6D88\u606F\u5DF2\u64A4\u56DE\uFF0C\u7B49\u5F85\u91CD\u53D1",
  "action.copied": "\u5DF2\u590D\u5236",
  "action.copyEmpty": "\u8FD9\u6761\u6D88\u606F\u6CA1\u6709\u53EF\u590D\u5236\u7684\u6587\u5B57",
  "confirm.title": "\u786E\u8BA4\u91CD\u53D1",
  "confirm.text": "\u8FD9\u6761\u6D88\u606F\u4E4B\u540E\u7684 {count} \u8F6E\u4F1A\u88AB\u64A4\u6389\uFF0C\u754C\u9762\u4E0A\u4E5F\u4F1A\u6D88\u5931\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D",
  "confirm.unknown": "\u8FD9\u6761\u6D88\u606F\u4E4B\u540E\u7684\u5185\u5BB9\u4F1A\u88AB\u64A4\u6389\uFF0C\u754C\u9762\u4E0A\u4E5F\u4F1A\u6D88\u5931\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D",
  "confirm.edit": "\u5185\u5BB9\u4F1A\u653E\u56DE\u8F93\u5165\u6846\uFF0C\u8FD9\u6761\u6D88\u606F\u7ACB\u523B\u4ECE\u5BF9\u8BDD\u91CC\u64A4\u6389",
  "confirm.editText": "\u5185\u5BB9\u4F1A\u653E\u56DE\u8F93\u5165\u6846\uFF0C\u8FD9\u6761\u6D88\u606F\u7ACB\u523B\u64A4\u6389\uFF1B\u4E4B\u540E\u7684 {count} \u8F6E\u4F1A\u5728\u53D1\u9001\u540E\u79BB\u5F00",
  "confirm.editUnknown": "\u5185\u5BB9\u4F1A\u653E\u56DE\u8F93\u5165\u6846\uFF0C\u8FD9\u6761\u6D88\u606F\u7ACB\u523B\u64A4\u6389\uFF1B\u4E4B\u540E\u7684\u5185\u5BB9\u4F1A\u5728\u53D1\u9001\u540E\u79BB\u5F00",
  "confirm.editReplace": "\u8F93\u5165\u6846\u91CC\u73B0\u6709\u7684\u5185\u5BB9\u4F1A\u88AB\u66FF\u6362",
  "confirm.cancel": "\u53D6\u6D88",
  "confirm.go": "\u4ECD\u7136\u91CD\u65B0\u751F\u6210",
  "confirm.goEdit": "\u64A4\u56DE\u5E76\u653E\u56DE\u8F93\u5165\u6846",
  "error.notOpen": "\u4F1A\u8BDD\u5C1A\u672A\u6253\u5F00\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
  "error.rejected": "\u91CD\u53D1\u5931\u8D25",
  "error.command": "\u5BBF\u4E3B\u6CA1\u6709\u6302\u8F7D\u91CD\u5199\u547D\u4EE4\uFF0C\u8BF7\u786E\u8BA4\u63D2\u4EF6\u5728\u5BBF\u4E3B\u4FA7\u5DF2\u52A0\u8F7D",
  "error.superseded": "\u8FD9\u6761\u6D88\u606F\u5DF2\u88AB\u91CD\u53D1\u66FF\u6362\uFF0C\u65E0\u6CD5\u518D\u6B21\u91CD\u53D1",
  "error.running": "\u56DE\u7B54\u8FD8\u5728\u751F\u6210\uFF0C\u5148\u505C\u6B62\u518D\u91CD\u53D1",
  "error.attachment": "\u56FE\u7247\u8BFB\u53D6\u5931\u8D25\uFF0C\u65E0\u6CD5\u91CD\u53D1"
};
var en = {
  "action.edit": "Edit and resend",
  "action.editHint": "Retract this message into the composer in one click; sending it answers the edited text",
  "action.retry": "Regenerate",
  "action.retryHint": "Drop this message and everything after it, then answer the same text again",
  "action.unsupported": "Messages with file attachments cannot be edited or retried yet",
  "action.running": "Generating \u2014 stop the answer before resending",
  "action.copy": "Copy",
  "action.cancel": "Cancel rewrite",
  "retract.pending": "This message was retracted and waits for a rewrite",
  "action.copied": "Copied",
  "action.copyEmpty": "This message has no text to copy",
  "confirm.title": "Confirm resend",
  "confirm.text": "The {count} turns after this message will be dropped and leave the transcript, with no way back",
  "confirm.unknown": "Everything after this message will be dropped and leave the transcript, with no way back",
  "confirm.edit": "The content moves to the composer and this message leaves the conversation right away",
  "confirm.editText": "The content moves to the composer and this message leaves right away; the {count} turns after it leave when you send",
  "confirm.editUnknown": "The content moves to the composer and this message leaves right away; everything after it leaves when you send",
  "confirm.editReplace": "What is already in the composer will be replaced",
  "confirm.cancel": "Cancel",
  "confirm.go": "Regenerate anyway",
  "confirm.goEdit": "Retract to composer",
  "error.notOpen": "The session is not open yet; try again in a moment",
  "error.rejected": "Resend failed",
  "error.command": "The host did not register the rewrite command; check that the plugin is loaded host-side",
  "error.superseded": "This message was already replaced by a resend, so it cannot be resent again",
  "error.running": "The answer is still generating; stop it before resending",
  "error.attachment": "An image could not be read back, so nothing was sent"
};

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions", "conversation", "uiConversation", "locale", "remote", "remote.commands"];
var NS = "redo";
var description = "Edit or retry a sent user message and regenerate in place";
var RANGES = /* @__PURE__ */ new Map();
var RETRACTIONS = /* @__PURE__ */ new Map();
var PENDING = /* @__PURE__ */ new Map();
// Which message the redo is currently armed for, per session, plus a tiny
// external store so the visible message row can render a cancel control.
var ARMED = /* @__PURE__ */ new Map();
var ARMED_REVISION = /* @__PURE__ */ new Map();
var ARMED_LISTENERS = /* @__PURE__ */ new Map();
function armedGet(id) {
  return ARMED.get(id);
}
function armedSet(id, seq) {
  if (seq === void 0) ARMED.delete(id);
  else ARMED.set(id, seq);
  ARMED_REVISION.set(id, (ARMED_REVISION.get(id) ?? 0) + 1);
  const listeners = ARMED_LISTENERS.get(id);
  if (listeners !== void 0) for (const listener of listeners) listener();
}
function armedSubscribe(id, listener) {
  let listeners = ARMED_LISTENERS.get(id);
  if (listeners === void 0) {
    listeners = /* @__PURE__ */ new Set();
    ARMED_LISTENERS.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
var PENDING_TTL_MS = 5 * 60 * 1e3;
function isPendingSeq(sessionId, seq) {
  return PENDING.get(sessionId)?.has(seq) === true;
}
function isSupersededSeq(sessionId, seq) {
  const intervals = RANGES.get(sessionId);
  return intervals !== void 0 && covers(intervals, seq);
}
function contentParts(content) {
  const texts = [];
  const attachments = [];
  const rest = [];
  for (const block of content) {
    const candidate = block;
    if (candidate.type === "text" && typeof candidate.text === "string") texts.push(candidate.text);
    else if (candidate.type === "image" && candidate.attachment !== void 0) {
      attachments.push({ type: "image", image: { attachment: candidate.attachment } });
    } else if (candidate.type === "file" && candidate.attachment !== void 0) {
      attachments.push({ type: "file", file: candidate.attachment });
    } else rest.push(block);
  }
  return { text: texts.join(""), attachments, rest };
}
function redoLayout(content) {
  const texts = [];
  const images = [];
  let blockedByFile = false;
  let blockedByOther = false;
  for (const block of content) {
    const candidate = block;
    if (candidate.type === "text" && typeof candidate.text === "string") texts.push(candidate.text);
    else if (candidate.type === "image" && candidate.attachment !== void 0) images.push(candidate.attachment);
    else if (candidate.type === "file") blockedByFile = true;
    else blockedByOther = true;
  }
  return { text: texts.join(""), images, blockedByFile, blockedByOther };
}
function partsFor(text, images) {
  const parts = [];
  if (text.trim() !== "") parts.push({ type: "text", text });
  for (const attachment of images) parts.push({ type: "image", attachment });
  return parts;
}
function toBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
function extensionOf(mediaType) {
  if (mediaType === "image/jpeg") return "jpg";
  return mediaType.slice("image/".length);
}
async function copyText(text) {
  if (text === "") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
function clockLabel(time, localeId) {
  const when = new Date(time);
  const now = /* @__PURE__ */ new Date();
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  const options = sameDay ? { hour: "2-digit", minute: "2-digit" } : when.getFullYear() === now.getFullYear() ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(localeId, options).format(when);
  } catch {
    return new Intl.DateTimeFormat(void 0, options).format(when);
  }
}
function uuid() {
  const generator = globalThis.crypto;
  if (typeof generator?.randomUUID === "function") return generator.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function CopyIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "5.75", y: "5.75", width: "7.5", height: "7.5", rx: "1.5", stroke: "currentColor", strokeWidth: "1.1" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "path",
      {
        d: "M10.25 3.5c0-.69-.56-1.25-1.25-1.25H3.75c-.69 0-1.25.56-1.25 1.25V8c0 .69.56 1.25 1.25 1.25",
        stroke: "currentColor",
        strokeWidth: "1.1",
        strokeLinecap: "round"
      }
    )
  ] });
}
function CheckIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "path",
    {
      d: "M3.2 8.4 6.3 11.5 12.8 4.7",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ) });
}
function RedoUserMessage({
  node,
  renderFactorySlot,
  loadImage,
  t,
  resend,
  arm,
  laterTurns,
  subscribeRunning,
  isRunning,
  sessionId,
  localeId,
  inputActions,
  useInput,
  subscribeSuperseded,
  supersededRevision,
  isHidden,
  isPending,
  cancelRetract,
  subscribeArmed,
  armedTarget,
  shadowedCommandKeys,
  retractionTurns
}) {
  const data = node.data;
  const parts = (0, import_react.useMemo)(() => contentParts(data.content), [data.content]);
  const content = (0, import_react.useMemo)(() => ({
    text: parts.text,
    attachments: parts.attachments,
    extraBlocks: parts.rest,
    ...data.referenceLabels === void 0 ? {} : { referenceLabels: data.referenceLabels }
  }), [parts, data.referenceLabels]);
  const facts = (0, import_react.useMemo)(() => ({
    ...data.referenceLabels === void 0 ? {} : { sessionLabels: data.referenceLabels },
    ...data.skillNames === void 0 ? {} : { skillNames: data.skillNames }
  }), [data.referenceLabels, data.skillNames]);
  (0, import_react.useSyncExternalStore)(subscribeSuperseded, supersededRevision);
  const hidden = isHidden(data.seq);
  const composerOccupied = useInput((state) => state.draft.trim() !== "" || state.attachmentIds.length > 0);
  const armedSeq = (0, import_react.useSyncExternalStore)(subscribeArmed, armedTarget);
  const rowRef = (0, import_react.useRef)(null);
  (0, import_react.useLayoutEffect)(() => {
    if (!hidden) return void 0;
    const flow = rowRef.current?.closest('[data-slot="conversation.chat.flow"]') ?? null;
    if (flow === null) return void 0;
    const marked = /* @__PURE__ */ new Set();
    const apply2 = () => {
      const turn = rowRef.current?.closest("[data-chat-turn]")?.getAttribute("data-chat-turn") ?? null;
      if (turn === null || !/^\d+$/u.test(turn)) return;
      const items = [...flow.querySelectorAll(`[data-chat-turn="${turn}"]`)];
      for (const carried of retractionTurns()) {
        items.push(...flow.querySelectorAll(`[data-chat-turn="${String(carried)}"]`));
      }
      for (const key of shadowedCommandKeys()) {
        items.push(...flow.querySelectorAll(`[data-chat-node-key$="${key}"]`));
      }
      for (const item of items) {
        item.setAttribute("data-dsh-redo-hidden", "");
        marked.add(item);
      }
    };
    apply2();
    const observer = new MutationObserver(apply2);
    observer.observe(flow, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const item of marked) item.removeAttribute("data-dsh-redo-hidden");
    };
  }, [hidden, retractionTurns, shadowedCommandKeys]);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [failure, setFailure] = (0, import_react.useState)(void 0);
  const [pending, setPending] = (0, import_react.useState)(void 0);
  const [dropCount, setDropCount] = (0, import_react.useState)(void 0);
  const [copied, setCopied] = (0, import_react.useState)(false);
  const copyTimer = (0, import_react.useRef)(null);
  const layout = (0, import_react.useMemo)(() => redoLayout(data.content), [data.content]);
  const editable = !layout.blockedByFile && !layout.blockedByOther;
  const retryable = editable && (layout.text.trim() !== "" || layout.images.length > 0);
  const running = (0, import_react.useSyncExternalStore)(subscribeRunning, isRunning);
  const canRetry = retryable && !running;
  const canEdit = editable && !running;
  (0, import_react.useEffect)(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const fail = (0, import_react.useCallback)((result) => {
    if (result.code === "not-open") return t("error.notOpen");
    if (result.code === "command") return t("error.command");
    if (result.code === "attachment") return t("error.attachment");
    if (result.code === "superseded") return t("error.superseded");
    if (result.code === "running") return t("error.running");
    return result.message === void 0 || result.message === "" ? t("error.rejected") : result.message;
  }, [t]);
  const runRetry = (0, import_react.useCallback)(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(void 0);
    setPending(void 0);
    try {
      const result = await resend(data.seq, partsFor(layout.text, layout.images));
      if (!result.ok) setFailure(fail(result));
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }, [busy, data.seq, fail, layout, resend]);
  const runEdit = (0, import_react.useCallback)(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(void 0);
    setPending(void 0);
    try {
      const staged = await arm(data.seq, layout.images);
      if (!staged.ok) {
        setFailure(fail(staged));
        return;
      }
      inputActions.setDraft(layout.text);
      if (staged.draftIds.length > 0 && !inputActions.addAttachments(staged.draftIds)) {
        setFailure(t("error.attachment"));
      }
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }, [arm, busy, data.seq, fail, inputActions, layout, t]);
  const requestRetry = (0, import_react.useCallback)(() => {
    if (busy || !canRetry) return;
    const later = laterTurns(data.seq);
    if (later === 0) {
      void runRetry();
      return;
    }
    setDropCount(later);
    setPending("retry");
  }, [busy, canRetry, data.seq, laterTurns, runRetry]);
  const requestEdit = (0, import_react.useCallback)(() => {
    if (busy || !canEdit) return;
    const later = laterTurns(data.seq);
    if (later === 0 && !composerOccupied) {
      void runEdit();
      return;
    }
    setDropCount(later);
    setPending("edit");
  }, [busy, canEdit, composerOccupied, data.seq, laterTurns, runEdit]);
  const copy = (0, import_react.useCallback)(async () => {
    if (parts.text === "" || copied) return;
    const ok = await copyText(parts.text);
    if (!ok) return;
    setCopied(true);
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null;
      setCopied(false);
    }, 1e3);
  }, [copied, parts.text]);
  const confirmation = pending === "retry" ? dropCount === void 0 ? t("confirm.unknown") : t("confirm.text", { count: dropCount }) : dropCount === void 0 ? t("confirm.editUnknown") : dropCount === 0 ? t("confirm.edit") : t("confirm.editText", { count: dropCount });
  const retryTitle = running ? t("action.running") : retryable ? t("action.retryHint") : t("action.unsupported");
  const editTitle = running ? t("action.running") : editable ? t("action.editHint") : t("action.unsupported");
  const copyTitle = parts.text === "" ? t("action.copyEmpty") : copied ? t("action.copied") : t("action.copy");
  if (hidden) {
    if (!isPending(data.seq)) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: rowRef });
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
      className: "dsh-redo-retracted",
      ref: rowRef,
      style: { position: "fixed", right: "24px", bottom: "104px", zIndex: 40, display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", borderRadius: "10px", border: "1px solid var(--dsw-alias-border-l2,#ddd)", background: "var(--dsw-alias-bg-layer-1,#fff)", boxShadow: "0 6px 20px rgba(0,0,0,.12)", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#555)" },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("retract.pending") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
          type: "button",
          style: { marginLeft: "auto", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2,#ddd)", background: "transparent", cursor: "pointer", color: "inherit" },
          onClick: (event) => {
            event.stopPropagation();
            void cancelRetract(data.seq);
            inputActions.setDraft("");
          },
          children: t("action.cancel")
        })
      ]
    });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-redo-row", ref: rowRef, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-redo-content", children: renderFactorySlot("conversation.chat.user.content", { content, loadImage, facts, interactive: true }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-redo-meta", children: [
      typeof data.time === "number" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-redo-time", children: clockLabel(data.time, localeId) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-action",
          "aria-label": copyTitle,
          title: copyTitle,
          disabled: parts.text === "",
          "aria-disabled": parts.text === "" ? true : void 0,
          "data-unavailable": parts.text === "" ? true : void 0,
          onClick: (event) => {
            event.stopPropagation();
            void copy();
          },
          children: copied ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CheckIcon, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CopyIcon, {})
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-action",
          "aria-label": t("action.retry"),
          title: retryTitle,
          disabled: !canRetry,
          "aria-disabled": canRetry ? void 0 : true,
          "data-unavailable": canRetry ? void 0 : true,
          "data-busy": busy ? true : void 0,
          onClick: (event) => {
            event.stopPropagation();
            requestRetry();
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "path",
            {
              d: "M13 8a5 5 0 1 1-1.6-3.7M13 2.6V6h-3.4",
              stroke: "currentColor",
              strokeWidth: "1.3",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          ) })
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-action",
          "aria-label": t("action.edit"),
          title: editTitle,
          disabled: !canEdit,
          "aria-disabled": canEdit ? void 0 : true,
          "data-unavailable": canEdit ? void 0 : true,
          "data-busy": busy ? true : void 0,
          onClick: (event) => {
            event.stopPropagation();
            requestEdit();
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "path",
            {
              d: "M11.1 1.9a1.4 1.4 0 0 1 2 2L5.4 11.6l-2.7.8.8-2.7 7.6-7.8Z",
              stroke: "currentColor",
              strokeWidth: "1.2",
              strokeLinejoin: "round"
            }
          ) })
        }
      ),
      armedSeq === data.seq ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-action",
          "aria-label": t("action.cancel"),
          title: t("action.cancel"),
          style: { width: "auto", padding: "0 7px", fontSize: "11px" },
          onClick: (event) => {
            event.stopPropagation();
            void cancelRetract(data.seq);
            inputActions.setDraft("");
          },
          children: t("action.cancel")
        }
      ) : null
    ] }),
    pending === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-redo-confirm", role: "group", "aria-label": t("confirm.title"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-redo-confirm-text", children: [
        confirmation,
        pending === "edit" && composerOccupied ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-redo-confirm-note", children: t("confirm.editReplace") }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-button dsh-redo-small",
          onClick: () => {
            setPending(void 0);
          },
          children: t("confirm.cancel")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dsh-redo-button dsh-redo-small dsh-redo-danger",
          onClick: () => {
            void (pending === "retry" ? runRetry() : runEdit());
          },
          children: pending === "retry" ? t("confirm.go") : t("confirm.goEdit")
        }
      )
    ] }),
    failure === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-redo-inline-error", role: "alert", children: failure })
  ] });
}
var CSS = `
[data-dsh-redo-hidden] { display: none !important; }
.dsh-redo-row { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; }
.dsh-redo-content { display: flex; flex-direction: column; align-items: flex-end; width: 100%; min-width: 0; }
.dsh-redo-meta {
  display: flex; align-items: center; gap: 8px;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
}
.dsh-redo-time {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary); white-space: nowrap; padding-right: 12px;
}
.dsh-redo-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  transition: background .1s ease, color .1s ease;
}
.dsh-redo-action svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
.dsh-redo-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dsh-redo-action[data-unavailable] { cursor: not-allowed; opacity: .4; }
.dsh-redo-action[data-unavailable]:hover { color: var(--dsw-alias-label-tertiary); background: transparent; }
.dsh-redo-action[data-busy] { opacity: .55; cursor: progress; }
.dsh-redo-inline-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-redo-confirm {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-redo-confirm-text { min-width: 0; }
.dsh-redo-confirm-note { display: block; color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) {
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]) .dsh-redo-row .dsh-redo-meta {
    opacity: 0; transition: opacity 80ms;
  }
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):hover .dsh-redo-row .dsh-redo-meta,
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):focus-within .dsh-redo-row .dsh-redo-meta {
    opacity: 1;
  }
}
.dsh-redo-button {
  height: 30px; padding: 0 14px; border-radius: var(--dsw-radius-md); cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.dsh-redo-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.dsh-redo-button:disabled { opacity: .5; cursor: not-allowed; }
.dsh-redo-small { height: 26px; padding: 0 10px; font-size: 12px; }
.dsh-redo-danger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-redo-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent);
}
`;
function clientSessions(ctx) {
  return ctx.sessions;
}
function conversationDrafts(ctx) {
  return ctx.conversation;
}
function remoteCommands(ctx) {
  return ctx.remote;
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-redo: dictionaries");
  ctx.effect(() => {
    const id = "dsh-redo-style";
    if (document.getElementById(id) !== null) return () => {
    };
    const style = document.createElement("style");
    style.id = id;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, "dsh-redo: styles");
  const runningSources = /* @__PURE__ */ new Map();
  const runningSource = (id) => {
    const existing = runningSources.get(id);
    if (existing !== void 0) return existing;
    const resolve = () => clientSessions(ctx).binding(id)?.session;
    const source = {
      subscribe: (listener) => resolve()?.subscribe(listener) ?? (() => {
      }),
      isRunning: () => resolve()?.getSnapshot().running ?? false
    };
    runningSources.set(id, source);
    return source;
  };
  const rangeFeeds = /* @__PURE__ */ new Map();
  const rangeStops = [];
  const rangeFeed = (id) => {
    const existing = rangeFeeds.get(id);
    if (existing !== void 0) return existing;
    let revision = 0;
    const listeners = /* @__PURE__ */ new Set();
    const pending = PENDING.get(id) ?? /* @__PURE__ */ new Map();
    PENDING.set(id, pending);
    const publish = (intervals, turns) => {
      const previous = RANGES.get(id);
      const previousTurns = RETRACTIONS.get(id);
      const sameRanges = previous !== void 0 && previous.length === intervals.length && previous.every((interval, index) => interval.from === intervals[index]?.from && interval.to === intervals[index]?.to);
      const sameTurns = previousTurns !== void 0 && previousTurns.length === turns.length && previousTurns.every((turn, index) => turn === turns[index]);
      RANGES.set(id, intervals);
      RETRACTIONS.set(id, turns);
      const before = pending.size;
      for (const seq of [...pending.keys()]) if (covers(intervals, seq)) pending.delete(seq);
      if (sameRanges && sameTurns && pending.size === before) return;
      revision += 1;
      for (const listener of listeners) listener();
    };
    let unsubscribe;
    const read = () => {
      const binding = clientSessions(ctx).binding(id);
      if (binding === void 0) return;
      const events = [];
      for (const entry of binding.eventSource.getSnapshot().entries) {
        if (entry.type === "event") events.push(entry.event);
      }
      publish(deriveIntervals(events), deriveRetractionTurns(events));
      if (unsubscribe === void 0) {
        const stop = binding.eventSource.subscribe(read);
        unsubscribe = stop;
        rangeStops.push(stop);
      }
    };
    const feed = {
      subscribe: (listener) => {
        read();
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      revision: () => revision,
      // The Host rewrites at the next send, so between the click and that send
      // nothing in the log says the message is gone. The row hides right away
      // anyway; the mark expires with the Host's own arm window, and the event
      // window takes the hide over once the replacement lands.
      markPending: (seq) => {
        pending.set(seq, Date.now());
        revision += 1;
        for (const listener of listeners) listener();
        const timer = setTimeout(() => {
          if (pending.get(seq) === void 0) return;
          if (covers(RANGES.get(id) ?? [], seq)) return;
          pending.delete(seq);
          revision += 1;
          for (const listener of listeners) listener();
        }, PENDING_TTL_MS);
        timer.unref?.();
      },
      // Abandon a pending retraction: the row becomes visible again without
      // touching the log (nothing was rewritten yet) and the Host arm is
      // cleared separately through `/redo off`.
      cancelPending: (seq) => {
        if (pending.get(seq) === void 0) return;
        pending.delete(seq);
        revision += 1;
        for (const listener of listeners) listener();
      }
    };
    rangeFeeds.set(id, feed);
    return feed;
  };
  ctx.effect(() => () => {
    for (const stop of rangeStops) stop();
  }, "dsh-redo: interval feeds");
  const commandKeyReaders = /* @__PURE__ */ new Map();
  const shadowedCommandKeys = (id) => {
    const existing = commandKeyReaders.get(id);
    if (existing !== void 0) return existing;
    const read = () => {
      const snapshot = ctx.uiConversation.binding(id).target("chat").getSnapshot();
      if (snapshot === void 0) return [];
      const keys = [];
      for (const value of snapshot.nodes.values()) {
        if (value.kind !== "command") continue;
        const data = value.data;
        if (typeof data?.commandId !== "string" || data.name !== "redo") continue;
        const target = Number(String(data.args ?? "").trim());
        if (!Number.isSafeInteger(target) || !isSupersededSeq(id, target)) continue;
        keys.push(`command${data.commandId}`);
      }
      return keys;
    };
    commandKeyReaders.set(id, read);
    return read;
  };
  const retractionReaders = /* @__PURE__ */ new Map();
  const retractionTurns = (id) => {
    const existing = retractionReaders.get(id);
    if (existing !== void 0) return existing;
    const read = () => RETRACTIONS.get(id) ?? [];
    retractionReaders.set(id, read);
    return read;
  };
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "user",
    // The shipped cell registers at the default rank 0; a lower rank replaces
    // this one cell without touching any other renderer.
    priority: -10,
    locale: NS,
    inject: (sessionId) => ({
      sessionId,
      // Read per occurrence so a language change updates the clock without a reload.
      localeId: ctx.locale.getLocale().active,
      subscribeRunning: runningSource(sessionId).subscribe,
      isRunning: runningSource(sessionId).isRunning,
      subscribeSuperseded: rangeFeed(sessionId).subscribe,
      supersededRevision: rangeFeed(sessionId).revision,
      isHidden: (seq) => isSupersededSeq(sessionId, seq) || isPendingSeq(sessionId, seq),
      isPending: (seq) => isPendingSeq(sessionId, seq),
      cancelRetract: async (target) => {
        await remoteCommands(ctx).commands.execute(sessionId, "/redo off", []);
        armedSet(sessionId, void 0);
        rangeFeed(sessionId).cancelPending(target);
      },
      subscribeArmed: (listener) => armedSubscribe(sessionId, listener),
      armedTarget: () => armedGet(sessionId),
      shadowedCommandKeys: shadowedCommandKeys(sessionId),
      retractionTurns: retractionTurns(sessionId),
      laterTurns: (target) => {
        const binding = clientSessions(ctx).binding(sessionId);
        if (binding === void 0) return void 0;
        const snapshot = ctx.uiConversation.binding(sessionId).target("chat").getSnapshot();
        if (snapshot === void 0) return void 0;
        let later = 0;
        for (const value of snapshot.nodes.values()) {
          if (value.kind !== "user") continue;
          const data = value.data;
          if (typeof data?.seq !== "number" || data.seq <= target) continue;
          if (isSupersededSeq(sessionId, data.seq)) continue;
          later += 1;
        }
        return later;
      },
      arm: async (target, images) => {
        if (isSupersededSeq(sessionId, target)) return { ok: false, code: "superseded" };
        const binding = clientSessions(ctx).binding(sessionId);
        if (binding === void 0) return { ok: false, code: "not-open" };
        const session = binding.session;
        if (session.getSnapshot().running) return { ok: false, code: "running" };
        const files = [];
        for (const [index, image] of images.entries()) {
          const stored = await session.readAttachment(image.attachmentId);
          if (!stored.ok) return { ok: false, code: "attachment" };
          files.push(new File(
            [stored.value.data],
            image.name ?? `redo-${String(target)}-${String(index)}.${extensionOf(image.mediaType)}`,
            { type: image.mediaType }
          ));
        }
        const drafts = files.length === 0 ? [] : conversationDrafts(ctx).createDrafts(sessionId, files, true);
        const verdict = classifyCommandRun(await remoteCommands(ctx).commands.execute(
          sessionId,
          `/redo ${String(target)}`,
          []
        ));
        if (!verdict.ok) return verdict;
        armedSet(sessionId, target);
        return { ok: true, draftIds: drafts.map((draft) => draft.id) };
      },
      resend: async (target, parts) => {
        if (isSupersededSeq(sessionId, target)) return { ok: false, code: "superseded" };
        const binding = clientSessions(ctx).binding(sessionId);
        if (binding === void 0) return { ok: false, code: "not-open" };
        const session = binding.session;
        if (session.getSnapshot().running) return { ok: false, code: "running" };
        const wire = await Promise.all(parts.map(async (part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          const stored = await session.readAttachment(part.attachment.attachmentId);
          if (!stored.ok) return void 0;
          return {
            type: "image",
            mediaType: part.attachment.mediaType,
            data: toBase64(stored.value.data),
            ...part.attachment.name === void 0 ? {} : { name: part.attachment.name }
          };
        }));
        if (wire.some((part) => part === void 0)) return { ok: false, code: "attachment" };
        const requestId = `redo:${String(target)}:${uuid()}`;
        const result = await session.prompt(wire, "queue", void 0, requestId);
        return result.ok ? { ok: true } : { ok: false, code: "rejected", message: result.error.message };
      }
    })
  }, RedoUserMessage));
}
		return module.exports;
	}
});
