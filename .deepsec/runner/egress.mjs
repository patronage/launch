import http from "node:http";
import net from "node:net";

export const allowedDestination = (authority) =>
  new Set(["chatgpt.com:443", "auth.openai.com:443"]).has(authority);

export const createEgressProxy = () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });

  server.maxConnections = 64;
  server.on("connect", (request, client, head) => {
    if (!allowedDestination(request.url)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");

      return;
    }

    const host = request.url.slice(0, -4);
    const upstream = net.connect({ host, port: 443 });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.setTimeout(300_000, () => client.destroy());
    upstream.setTimeout(300_000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      if (head.length > 0) {
        upstream.write(head);
      }

      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  return server;
};

if (import.meta.main) {
  createEgressProxy().listen(8080, "0.0.0.0");
}
