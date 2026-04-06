import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { ProjectStore } from './projectStore.js';
import { registerRoutes } from './routes.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const store = new ProjectStore();

  await app.register(cors, { origin: true });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Apex BIM API',
        description: 'Базовый REST для снимка элементов и внешних плагинов',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:8787', description: 'локальная разработка' }],
      tags: [
        { name: 'system', description: 'Системные' },
        { name: 'elements', description: 'Элементы модели' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await registerRoutes(app, store);

  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Apex API http://localhost:${port}  Swagger: /documentation`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
