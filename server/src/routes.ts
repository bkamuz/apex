import type { FastifyInstance } from 'fastify';
import type { ElementsSnapshotDto } from '../../shared/dto.ts';
import type { ProjectStore } from './projectStore.js';

const elementDtoSchema = {
  type: 'object',
  required: ['id', 'kind', 'category', 'name', 'levelId', 'parameters', 'geometry'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['ifc', 'native'] },
    category: { type: 'string' },
    name: { type: 'string' },
    levelId: { type: ['string', 'null'] },
    expressId: { type: 'number' },
    parameters: { type: 'object', additionalProperties: true },
    geometry: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'expressId'],
          properties: { kind: { const: 'ifc' }, expressId: { type: 'number' } },
        },
        {
          type: 'object',
          required: ['kind', 'objectUuid'],
          properties: { kind: { const: 'native' }, objectUuid: { type: 'string' } },
        },
      ],
    },
  },
} as const;

export async function registerRoutes(
  app: FastifyInstance,
  store: ProjectStore
): Promise<void> {
  app.get(
    '/api/v1/health',
    {
      schema: {
        description: 'Проверка доступности API',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
          },
        },
      },
    },
    async () => ({ ok: true as const })
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/elements',
    {
      schema: {
        description: 'Снимок всех элементов проекта',
        tags: ['elements'],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              updatedAt: { type: 'string' },
              elements: { type: 'array', items: elementDtoSchema },
            },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const snap = store.getSnapshot(request.params.projectId);
      if (!snap) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      return snap;
    }
  );

  app.get<{ Params: { projectId: string; elementId: string } }>(
    '/api/v1/projects/:projectId/elements/:elementId',
    {
      schema: {
        description: 'Один элемент по id',
        tags: ['elements'],
        params: {
          type: 'object',
          required: ['projectId', 'elementId'],
          properties: {
            projectId: { type: 'string' },
            elementId: { type: 'string' },
          },
        },
        response: {
          200: elementDtoSchema,
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const el = store.getElement(
        request.params.projectId,
        request.params.elementId
      );
      if (!el) {
        return reply.status(404).send({ error: 'Element not found' });
      }
      return el;
    }
  );

  app.put<{ Params: { projectId: string }; Body: ElementsSnapshotDto }>(
    '/api/v1/projects/:projectId/elements',
    {
      schema: {
        description: 'Полная замена снимка элементов (синхронизация с клиента)',
        tags: ['elements'],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['projectId', 'updatedAt', 'elements'],
          additionalProperties: true,
          properties: {
            projectId: { type: 'string' },
            updatedAt: { type: 'string' },
            elements: { type: 'array', items: elementDtoSchema },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              count: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.projectId !== request.params.projectId) {
        return reply
          .status(400)
          .send({ error: 'projectId mismatch' });
      }
      store.putSnapshot(body);
      return { ok: true as const, count: body.elements.length };
    }
  );
}
