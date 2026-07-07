import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env, isDevelopment } from "./env.js";
import { orderRoutes } from "./routes/orders.js";
import pino, { type DestinationStream } from "pino";

const createLogger = () => {
  const transport = isDevelopment ? { target: "pino-pretty" } : undefined;

  return pino({
    level: env.LOG_LEVEL,
    transport,
  });
};

export async function buildApp() {
  const logger = createLogger();

  const app = Fastify({
    logger,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(orderRoutes);

  return app;
}
