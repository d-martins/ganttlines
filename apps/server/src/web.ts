import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

/** Hashed build assets never change under the same name; everything else is revalidated. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the built web app (apps/web/dist) from the same origin as the API. Any other page URL gets
 * index.html so client-side routes (/p/:id, /s/:token …) load; unknown /api, /ws and asset paths
 * stay 404s.
 */
export async function webRoutes(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webDir,
    index: false,
    cacheControl: false, // set below: long for hashed assets, revalidate for the rest
    setHeaders: (response, path) => response.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? IMMUTABLE : "no-cache"),
  });
  const page = (reply: FastifyReply) =>
    reply
      .header("Cache-Control", "no-cache")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer") // link and reset tokens are in page addresses
      .header("X-Frame-Options", "DENY")
      .sendFile("index.html");
  app.get("/", (_request, reply) => page(reply));
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const isPage = (request.method === "GET" || request.method === "HEAD") && !/^\/(api|ws|assets)(\/|$)/.test(path);
    return isPage ? page(reply) : reply.status(404).send({ error: "not_found", message: "Not found" });
  });
}
