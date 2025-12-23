import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
}

export function getCorsHeaders(
  event: APIGatewayProxyEvent,
  allowMethods: string
): Record<string, string> {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = event.headers?.origin ?? event.headers?.Origin;
  const allowOrigin =
    requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins.length > 0
      ? allowedOrigins[0]
      : "*";

  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "content-type,accept,authorization",
    "access-control-allow-methods": allowMethods,
    vary: "Origin",
  };
}

export function json(
  event: APIGatewayProxyEvent,
  statusCode: number,
  body: unknown,
  allowMethods: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: getCorsHeaders(event, allowMethods),
    body: JSON.stringify(body),
  };
}

export function readJsonBody<T>(event: APIGatewayProxyEvent): T {
  const raw = event.body ?? "";
  const decoded = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf-8")
    : raw;
  return JSON.parse(decoded) as T;
}
