import { Buffer } from "node:buffer";
// alt: import { base64url } from "rfc4648";

export default {
  async fetch (request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    try {
      const auth = request.headers.get("Authorization");
      let apiKey = auth && auth.split(" ")[1];
      if (!apiKey) {
        throw new HttpError("Bad credentials", 401);
      }
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models") && request.method === "GET") {
        return handleModels(apiKey);
      } else if (url.pathname.endsWith("/chat/completions") && request.method === "POST") {
        const json = await request.json();
        if (!Array.isArray(json.messages)) {
          throw new HttpError(".messages array required", 400);
        }
        return handleRequest(json, apiKey);
      } else {
        throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      console.error(err.toString());
      return new Response(err, { status: err.status ?? 500, headers: fixCors() });
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = (headers) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

async function handleModels(apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: {
      "x-goog-api-key": apiKey,
      "x-goog-api-client": API_CLIENT,
    },
  });
  let body = response.body;
  if (response.ok) {
    body = await response.text();
    body = processModels(JSON.parse(body));
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: fixCors(response.headers) });
}

const processModels = (data) => {
  return JSON.stringify({
    object: "list",
    data: data.models.map((model) => ({
      id: model.name.replace("models/", ""),
      object: "model",
      created: 0,
      owned_by: "",
    })),
  }, null, "  ");
};

const DEFAULT_MODEL = "gemini-1.5-pro-latest";
// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.19.0"; // npm view @google/generative-ai version
async function handleRequest (req, apiKey) {
  const model = req.model?.startsWith("gemini-") ? req.model : DEFAULT_MODEL;
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-api-client": API_CLIENT,
    },
    body: JSON.stringify(await transformRequest(req)), // try
  });

  let body = response.body;
  if (response.ok) {
    let id = generateChatcmplId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          model, id, last: [],
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      body = processResponse(JSON.parse(body), model, id);
    }
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: fixCors(response.headers) });
}

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map((category) => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // { "error": { "code": 400, "message": "Only one candidate can be specified", "status": "INVALID_ARGUMENT" } }
  max_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  //..."topK"
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format?.type === "json_object") {
    cfg.response_mime_type = "application/json";
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return { role, parts };
  }
  // OpenAI "model": "gpt-4-vision-preview"
  // user:
  // An array of content parts with a defined type, each can be of type text or image_url when passing in images.
  // You can pass multiple images by adding multiple image_url content parts.
  // Image input is only supported when using the gpt-4-visual-preview model.
  for (const item of content) {
    switch (item.type) {
    case "text":
      parts.push({ text: item.text });
      break;
    case "image_url":
      parts.push(await parseImg(item.image_url.url));
      break;
    default:
      throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({ role: "model", parts: { text: " " } });
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
  // :"function_call",
};
const transformCandidates = (key, cand) => ({
  index: cand.index || 0, // 0-index is absent in new -002 models response
  [key]: { role: "assistant", content: cand.content?.parts[0].text },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
});
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const processResponse = (data, model, id) => {
  return JSON.stringify({
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
async function parseStreamFlush (controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

function transformResponseStream (data, stop, first) {
  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) { item.delta.content = ""; } else { delete item.delta.role; }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
  };
  if (stop && data.usageMetadata) {
    output.usage = transformUsage(data.usageMetadata);
  }
  return "data: " + JSON.stringify(output) + delimiter;
}
const delimiter = "\n\n";
async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) { return; }
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error(line);
    console.error(err);
    const length = this.last.length || 1; // at least 1 error msg
    const candidates = Array.from({ length }, (_, index) => ({
      finishReason: "error",
      content: { parts: [{ text: err }] },
      index,
    }));
    data = { candidates };
  }
  const cand = data.candidates[0]; // !!untested with candidateCount>1
  cand.index = cand.index || 0; // absent in new -002 models response
  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, false, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(transform(data));
  }
}
async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last.length > 0) {
    for (const data of this.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
