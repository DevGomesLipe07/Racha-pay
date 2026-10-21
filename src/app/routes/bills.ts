// Rotas da SharedBill (03 § Rotas). Nenhuma regra financeira aqui: validação, autorização e chamada ao serviço.

import { z } from 'zod';
import { withScope } from '../../infra/db/tx.ts';
import type { Router } from '../../infra/http/router.ts';
import { reconstructFromLedger, verifyChain } from '../../modules/ledger/chain.ts';
import { readLedger } from '../../modules/ledger/ledger-repo.ts';
import { loadReconciliation } from '../../modules/reconciliation/service.ts';
import { BILL_KINDS, COLLECTION_MODELS, loadBill } from '../../modules/shared-bills/repo.ts';
import * as bills from '../../modules/shared-bills/service.ts';
import { billView } from '../../modules/shared-bills/view.ts';
import { SPLIT_MODES } from '../../modules/split/engine.ts';
import { centsToJson } from '../../modules/split/money.ts';
import { resolveKnowledge } from '../../modules/expert/library.ts';
import { PERSONAL_TENANT_ID } from '../auth.ts';
import { AppError, conflict, forbidden, notFound } from '../errors.ts';
import { auditAllowed, preAuthorize } from '../guard.ts';
import { cents, param, parseBody, uuid } from '../http-helpers.ts';
import type { AppDeps } from '../deps.ts';
import { routeKit } from './common.ts';

const name60 = z.string().trim().min(1).max(60);

const createSchema = z
  .object({
    kind: z.enum(BILL_KINDS).default('OTHER'),
    title: z.string().trim().min(1).max(80),
    organizerName: name60.optional(),
    participants: z.array(name60).max(99).optional(),
    collectionModel: z.enum(COLLECTION_MODELS).optional(),
    tableLabel: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    splitMode: z.enum(SPLIT_MODES).optional(),
    discountCents: cents.optional(),
    serviceBp: z.number().int().min(0).max(10_000).optional(),
    tipCents: cents.optional(),
  })
  .strict();

const participantPatchSchema = z
  .object({
    name: name60.optional(),
    percentBp: z.number().int().min(0).max(10_000).nullable().optional(),
    manualCents: cents.nullable().optional(),
  })
  .strict();

const assigneesSchema = z.array(z.object({ participantId: uuid, weight: z.number().int().min(1).max(1000).optional() }).strict()).max(100);

const itemSchema = z
  .object({
    description: z.string().trim().min(1).max(120),
    unitPriceCents: cents,
    quantity: z.number().int().min(1).max(10_000).default(1),
    assignees: assigneesSchema.optional(),
  })
  .strict();

export function registerBillRoutes(router: Router, deps: AppDeps): void {
  const { pool, config, clock, rateLimiter } = deps;
  const { principalOf, ctxOf, onBill } = routeKit(deps);

  const links = (billId: string, shareToken: string, organizerToken?: string) => ({
    share: `${config.PUBLIC_BASE_URL}/#/s/${billId}/${shareToken}`,
    ...(organizerToken ? { organizer: `${config.PUBLIC_BASE_URL}/#/o/${billId}/${organizerToken}` } : {}),
  });

  router.post('/v1/bills', async (req) => {
    const principal = await principalOf(req);
    const input = parseBody(createSchema, req);
    let tenantId: string;
    let collectionModel = input.collectionModel;
    if (principal.kind === 'anonymous') {
      tenantId = PERSONAL_TENANT_ID;
      if (collectionModel === 'MERCHANT_COLLECTS') throw forbidden('conta pessoal é sempre de quem organiza (ORGANIZER_COLLECTS)');
      collectionModel = 'ORGANIZER_COLLECTS';
      const limits = await withScope(pool, { kind: 'tenant', tenantId }, (c) =>
        resolveKnowledge(c, 'RATE_LIMIT.ANON_BILL_CREATE', { tenantId }, clock.now()),
      );
      const hit = rateLimiter.hit('anon-bill-create', req.clientKey, limits.content);
      if (!hit.allowed) throw new AppError(429, 'RATE_LIMITED', 'muitas contas criadas; tente daqui a pouco', { retryAfterSeconds: hit.retryAfterSeconds });
    } else if (principal.kind === 'apiKey') {
      tenantId = principal.tenantId;
      collectionModel ??= 'MERCHANT_COLLECTS';
    } else {
      throw forbidden('use uma conta nova (sem credencial) ou uma chave de API');
    }
    const billId = bills.newBillId();
    const decision = await preAuthorize(pool, principal, 'bill.create', { tenantId, billId: null }, req.correlationId);
    const body = await withScope(pool, { kind: 'bill', tenantId, billId }, async (client) => {
      const ctx = ctxOf(principal, tenantId, req);
      const created = await bills.createBill(client, ctx, billId, {
        kind: input.kind,
        title: input.title,
        collectionModel: collectionModel as 'ORGANIZER_COLLECTS' | 'MERCHANT_COLLECTS',
        ...(input.organizerName ? { organizerName: input.organizerName } : {}),
        ...(input.participants ? { participantNames: input.participants } : {}),
        ...(input.tableLabel ? { tableLabel: input.tableLabel } : {}),
      });
      await auditAllowed(client, principal, decision, { tenantId, billId }, req.correlationId);
      return {
        bill: await billView(client, billId, { viewer: created.organizerToken ? 'organizer' : 'tenant' }),
        shareToken: created.shareToken,
        ...(created.organizerToken ? { organizerToken: created.organizerToken } : {}),
        links: links(billId, created.shareToken, created.organizerToken),
      };
    });
    return { status: 201, body };
  });

  router.get(
    '/v1/bills/:id',
    onBill('bill.read', async () => undefined),
  );

  router.patch(
    '/v1/bills/:id',
    onBill('bill.edit', async (client, ctx, req, billId) => {
      const p = parseBody(patchSchema, req);
      await bills.updateBill(client, ctx, billId, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.splitMode !== undefined ? { splitMode: p.splitMode } : {}),
        ...(p.discountCents !== undefined ? { discountCents: p.discountCents } : {}),
        ...(p.serviceBp !== undefined ? { serviceBp: p.serviceBp } : {}),
        ...(p.tipCents !== undefined ? { tipCents: p.tipCents } : {}),
      });
    }),
  );

  router.post(
    '/v1/bills/:id/cancel',
    onBill('bill.cancel', async (client, ctx, req, billId) => {
      const { reason } = parseBody(z.object({ reason: z.string().trim().max(200).default('cancelada pelo organizador') }).strict(), req);
      await bills.cancelBill(client, ctx, billId, reason);
    }),
  );

  router.post(
    '/v1/bills/:id/share-links',
    onBill(
      'bill.edit',
      async (client, ctx, _req, billId) => {
        const shareToken = await bills.issueShareToken(client, ctx, billId);
        return { shareToken, links: links(billId, shareToken) };
      },
      { status: 201, respond: 'result' },
    ),
  );

  router.post(
    '/v1/bills/:id/participants',
    onBill(
      'bill.edit',
      async (client, ctx, req, billId) => {
        const { name } = parseBody(z.object({ name: name60 }).strict(), req);
        return { participantId: await bills.addParticipant(client, ctx, billId, name) };
      },
      { status: 201 },
    ),
  );

  router.patch(
    '/v1/bills/:id/participants/:pid',
    onBill('bill.edit', async (client, ctx, req, billId) => {
      const p = parseBody(participantPatchSchema, req);
      await bills.updateParticipant(client, ctx, billId, param(req, 'pid'), {
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.percentBp !== undefined ? { percentBp: p.percentBp } : {}),
        ...(p.manualCents !== undefined ? { manualCents: p.manualCents } : {}),
      });
    }),
  );

  router.delete(
    '/v1/bills/:id/participants/:pid',
    onBill('bill.edit', async (client, ctx, req, billId) => bills.removeParticipant(client, ctx, billId, param(req, 'pid'))),
  );

  router.post(
    '/v1/bills/:id/items',
    onBill(
      'bill.edit',
      async (client, ctx, req, billId) => {
        const i = parseBody(itemSchema, req);
        const itemId = await bills.addItem(client, ctx, billId, {
          description: i.description,
          unitPriceCents: i.unitPriceCents,
          quantity: i.quantity,
          ...(i.assignees ? { assignees: i.assignees.map((a) => (a.weight ? { participantId: a.participantId, weight: a.weight } : { participantId: a.participantId })) } : {}),
        });
        return { itemId };
      },
      { status: 201 },
    ),
  );

  router.put(
    '/v1/bills/:id/items/:itemId/assignees',
    onBill('bill.edit', async (client, ctx, req, billId) => {
      const { assignees } = parseBody(z.object({ assignees: assigneesSchema }).strict(), req);
      await bills.setItemAssignees(
        client,
        ctx,
        billId,
        param(req, 'itemId'),
        assignees.map((a) => (a.weight ? { participantId: a.participantId, weight: a.weight } : { participantId: a.participantId })),
      );
    }),
  );

  router.delete(
    '/v1/bills/:id/items/:itemId',
    onBill('bill.edit', async (client, ctx, req, billId) => bills.removeItem(client, ctx, billId, param(req, 'itemId'))),
  );

  router.post(
    '/v1/bills/:id/splits/preview',
    onBill(
      'split.preview',
      async (client, ctx, _req, billId) => {
        const plan = await bills.previewSplit(client, ctx, billId);
        return { preview: planJson(plan) };
      },
      { respond: 'result' },
    ),
  );

  router.post(
    '/v1/bills/:id/splits',
    onBill(
      'split.confirm',
      async (client, ctx, req, billId) => {
        const { expectedTotalCents } = parseBody(z.object({ expectedTotalCents: cents }).strict(), req);
        const { version } = await bills.confirmSplit(client, ctx, billId, expectedTotalCents);
        return { splitVersion: version };
      },
      { status: 201 },
    ),
  );

  router.post(
    '/v1/bills/:id/splits/unlock',
    onBill('split.unlock', async (client, ctx, _req, billId) => bills.unlockSplit(client, ctx, billId)),
  );

  router.get(
    '/v1/bills/:id/reconciliation',
    onBill(
      'bill.read',
      async (client, _ctx, _req, billId) => {
        const bill = await loadBill(client, billId);
        if (!bill) throw notFound('conta');
        const { reconciliation: r, confirmed } = await loadReconciliation(client, bill);
        if (!confirmed) throw conflict('SPLIT_NOT_CONFIRMED', 'a divisão ainda não foi confirmada');
        return {
          state: bill.state,
          formula: 'TOTAL = PAGO + EM PROCESSAMENTO + ATRIBUÍDO NÃO PAGO + NÃO ATRIBUÍDO − EXCEDENTE',
          totalCents: centsToJson(r.totalCents),
          paidCents: centsToJson(r.paidCents),
          processingCents: centsToJson(r.processingCents),
          assignedUnpaidCents: centsToJson(r.assignedUnpaidCents),
          unassignedCents: centsToJson(r.unassignedCents),
          excessCents: centsToJson(r.excessCents),
          refundDueCents: centsToJson(r.refundDueCents),
          participants: r.participants.map((p) => ({
            participantId: p.participantId,
            dueCents: centsToJson(p.dueCents),
            paidCents: centsToJson(p.paidCents),
            selfSettledCents: centsToJson(p.selfSettledCents),
            processingCents: centsToJson(p.processingCents),
            unpaidCents: centsToJson(p.unpaidCents),
            excessCents: centsToJson(p.excessCents),
            refundDueCents: centsToJson(p.refundDueCents),
          })),
        };
      },
      { respond: 'result' },
    ),
  );

  router.get(
    '/v1/bills/:id/ledger',
    onBill(
      'bill.read',
      async (client, _ctx, _req, billId) => {
        const bill = await loadBill(client, billId);
        if (!bill) throw notFound('conta');
        const entries = await readLedger(client, billId);
        const verification = verifyChain(entries);
        const rebuilt = reconstructFromLedger(entries);
        const { reconciliation, confirmed } = await loadReconciliation(client, bill);
        // A reconstrução só pelo ledger deve bater com o estado atual do banco.
        const mismatches = confirmed
          ? reconciliation.participants
              .filter((p) => {
                const r = rebuilt.participants.get(p.participantId);
                const rebuiltPaid = (r?.paidCents ?? 0n) - (r?.refundRecordedCents ?? 0n) + (r?.selfSettledCents ?? 0n);
                return (r?.dueCents ?? 0n) !== p.dueCents || rebuiltPaid !== p.paidCents;
              })
              .map((p) => p.participantId)
          : [];
        return {
          verification,
          reconstruction: {
            consistent: mismatches.length === 0,
            mismatches,
            splitVersion: rebuilt.splitVersion,
            participants: [...rebuilt.participants].map(([participantId, p]) => ({
              participantId,
              dueCents: centsToJson(p.dueCents),
              paidCents: centsToJson(p.paidCents),
              selfSettledCents: centsToJson(p.selfSettledCents),
              refundRecordedCents: centsToJson(p.refundRecordedCents),
            })),
          },
          entries: entries.map((e) => ({
            seq: e.seq,
            type: e.type,
            payload: e.payload,
            actor: e.actor,
            correlationId: e.correlationId,
            occurredAt: e.occurredAt,
            prevHash: e.prevHash,
            entryHash: e.entryHash,
          })),
        };
      },
      { respond: 'result' },
    ),
  );
}

function planJson(plan: bills.SplitPlan) {
  const c = centsToJson;
  return {
    kind: plan.kind,
    mode: plan.step.mode,
    serviceBp: plan.serviceBp,
    totals: {
      subtotalCents: c(plan.totals.subtotalCents),
      discountCents: c(plan.totals.discountCents),
      serviceCents: c(plan.totals.serviceCents),
      tipCents: c(plan.totals.tipCents),
      totalCents: c(plan.totals.totalCents),
    },
    step: { totalCents: c(plan.step.totalCents), subtotalCents: c(plan.step.subtotalCents), serviceCents: c(plan.step.serviceCents) },
    shares: plan.cumulative.map((s) => ({
      participantId: s.participantId,
      itemsCents: c(s.itemsCents),
      discountCents: c(s.discountCents),
      serviceCents: c(s.serviceCents),
      tipCents: c(s.tipCents),
      totalCents: c(s.totalCents),
    })),
    pendingItemIds: plan.pendingItemIds,
    rules: plan.rules,
  };
}
