import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { streamChat, type Gateway } from "../src/openai.ts";
import { streamResponses } from "../src/responses.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(typeof address === "object" && address !== null ? address.port : 0);
  }));
}

const bodies: Array<Record<string, unknown>> = [];
const paths: string[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  request.on("end", () => {
    const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    bodies.push(parsed);
    paths.push(request.url ?? "");
    const model = parsed.model as string | undefined;
    if (model === "auth") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"no key"}}');
      return;
    }
    if (model === "limit") {
      response.writeHead(429, { "retry-after": "2", "x-request-id": "req_1" });
      response.end("slow down");
      return;
    }
    if (model === "context") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"code":"context_length_exceeded"}}');
      return;
    }
    if (request.url?.endsWith("/responses")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.reasoning_summary_text.delta","delta":"plan"}\n\n');
      response.write('data: {"type":"response.output_text.delta","delta":"hi "}\n\n');
      response.write('data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_2","name":"read","arguments":""}}\n\n');
      response.write('data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\\"file\\":"}\n\n');
      response.write('data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_2","name":"read","arguments":"{\\"file\\":\\"a\\"}"}}\n\n');
      response.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":2}}}\n\n');
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (model === "slow") {
      response.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      return;
    }
    response.write('data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hi "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"file\\""}}]}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a\\"}"}}]}}]}\n\n');
    response.write('data: {"usage":{"prompt_tokens":2}}\n\n');
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

const port = await listen(server);
const gateway: Gateway = { base_url: `http://127.0.0.1:${port}/v1`, api_key: "sk", idle_timeout_ms: 5_000 };
const request = { model: "ok", reasoning: "high", messages: [{ role: "user", content: "hi" }], tools: [], temperature: undefined, max_tokens: undefined, session: undefined };
const emitted: Array<{ text?: string; reasoning?: string }> = [];

const reply = await streamChat(gateway, request, undefined, (event) => emitted.push(event));
assert.equal(bodies[0]?.reasoning_effort, "high");
assert.equal(emitted.length, 2);
assert.equal(emitted[0]?.reasoning, "plan");
assert.equal(emitted[1]?.text, "hi ");
assert.equal(reply.message.content, "hi ");
assert.deepEqual(reply.message.tool_calls, [
  { id: "call_1", type: "function", function: { name: "read", arguments: '{"file":"a"}' } },
]);
assert.deepEqual(reply.usage, { prompt_tokens: 2 });

const responseRequest = {
  ...request,
  messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }],
};
const responseReply = await streamResponses(gateway, responseRequest, undefined, (event) => emitted.push(event));
assert.equal(paths.at(-1), "/v1/responses");
assert.equal(bodies.at(-1)?.instructions, "rules");
assert.deepEqual(bodies.at(-1)?.input, [{ role: "user", content: "hi" }]);
assert.equal(emitted.at(-2)?.reasoning, "plan");
assert.equal(emitted.at(-1)?.text, "hi ");
assert.equal(responseReply.message.content, "hi ");
assert.deepEqual(responseReply.message.tool_calls, [
  { id: "call_2", type: "function", function: { name: "read", arguments: '{"file":"a"}' } },
]);
assert.deepEqual(responseReply.usage, { input_tokens: 2 });

for (const [model, code, retry] of [["auth", -32050, undefined], ["limit", -32051, 2000], ["context", -32056, undefined]] as const) {
  await assert.rejects(
    streamChat({ ...gateway }, { ...request, model }, undefined, () => {}),
    (error: { code?: number; data?: { retry_after_ms?: number } }) => error.code === code && error.data?.retry_after_ms === retry,
  );
}

const controller = new AbortController();
const cancelled = streamChat(gateway, { ...request, model: "slow" }, controller.signal, () => {});
setTimeout(() => controller.abort(), 20);
await assert.rejects(cancelled, (error: { code?: number }) => error.code === -32013);

server.close();
console.log("model openai adapter ok: stream, tools, failures and cancellation");
