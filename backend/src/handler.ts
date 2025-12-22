import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export async function ping(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = event.headers?.origin ?? event.headers?.Origin;
  const allowOrigin =
    requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins.length > 0
      ? allowedOrigins[0]
      : "*";

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,OPTIONS",
      vary: "Origin",
    },
    body: JSON.stringify({ ok: true, message: "pong" }),
  };
}
