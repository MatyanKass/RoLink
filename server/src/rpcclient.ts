// POST /rpc to the RoLink process that owns the bridge port.
//
// Not fetch: Node's fetch (undici) gives up on a response whose headers take more than
// 300 s, and a forwarded call legitimately runs longer (playtest_scenario up to 615 s,
// generate_model and mesh builds 300 s). The owning process enforces every tool's own
// timeout, so this request has none.

import http from "node:http";

export interface RpcResponse {
  status: number;
  body: unknown;
}

export function postRpc(host: string, port: number, token: string, payload: unknown): Promise<RpcResponse> {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length, "x-rolink-token": token },
        agent: false,
        timeout: 0,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
          } catch {
            reject(new Error(`bad response from the RoLink process on port ${port} (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
