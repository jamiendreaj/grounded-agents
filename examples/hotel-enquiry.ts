/**
 * A hotel enquiry agent, built on the framework.
 *
 * This exists as proof rather than demonstration. The framework was extracted
 * from two agents that already worked, so the only honest test of it is
 * whether one of them can be expressed in it without the shape bending.
 *
 * What is left here is the whole domain: a prompt, four tools, and the rules
 * that are specific to selling hotel rooms. The loop, the budget, the stop
 * reasons, the number arithmetic and the "why can't I send this" sentence all
 * come from the framework and are not repeated.
 */

import { defineAgent, guards } from 'grounded-agents';
import type { ToolDefinition } from 'grounded-agents';

type Property = {
  name: string;
  room_types: { name: string }[];
  facts: Record<string, string | number>;
  rates?: Record<string, number>;
  booking: { direct_url: string };
};

/* ── the rules that are specific to this domain ───────────────────────── */

const confirmedBooking = guards.patternRule<Property, any>('confirmed_booking', [
  /\b(?:i|we)\s+(?:have\s+)?(?:confirm|confirmed|reserved|booked|held)\b/i,
  /\byour\s+(?:room|booking|reservation)\s+is\s+(?:now\s+)?(?:confirmed|reserved|booked|held)\b/i,
  /\b(?:ho|abbiamo)\s+(?:confermat|prenotat|bloccat)/i,
  /\bihr\s+Zimmer\s+ist\s+(?:reserviert|gebucht|best(?:ä|ae)tigt)\b/i,
  /已(?:经|經)?(?:确认|確認|预订|預訂|预定|預定|保留)/,
  /(?:подтвержда|подтвержде|подтвердил|забронирова|зарезервирова)/i,
  /تم\s*(?:تأكيد|الحجز|حجز)/,
  /(?:אישרתי|אישרנו|הזמנתי)/,
], { detail: (m) => `appears to confirm a booking: "${String(m[0]).trim()}"` });

const italianLeak = guards.rule<Property, any>('wrong_language', {
  test: (text: string, ctx) => {
    if (!ctx.expectLanguage || ctx.expectLanguage === 'it') return null;
    return /\b(?:gentile|cordiali saluti|camera|prenotazione|colazione|disponibilit)/i.test(text)
      ? true : null;
  },
  detail: (_h: unknown, _t: string, ctx) => `guest wrote in "${ctx.expectLanguage}" but the reply reads as Italian`,
});

/* ── the agent ────────────────────────────────────────────────────────── */

export default defineAgent<Property, { mode?: string }>({
  name: 'hotel-enquiry',

  prompt: (property, { mode }) => `You answer pre-booking enquiries for ${property.name}. You have one job: reply to a prospective guest in their own language, using only this property's own information, and move them toward booking on the hotel's own site.

PROPERTY
${JSON.stringify({ rooms: property.room_types, facts: property.facts, booking: property.booking }, null, 1)}

THE THREE RULES

1. GROUNDING. Everything factual comes from the dossier above or a tool result.
   If it does not answer the question, you do not know it. Say you will confirm
   it, and escalate.

2. PRICES COME FROM get_rate, NEVER FROM YOU. Never state, estimate or range a
   price the tool did not return.

3. YOU DO NOT CLOSE. Never confirm a reservation, never hold a room, never take
   a card. You send the booking link; the booking engine does the rest.

${mode === 'approve'
  ? 'Your reply is approved by a person before it reaches the guest. Write it as final text.'
  : 'Your reply goes to the guest as written. Re-read it once against the three rules.'}`,

  tools: (property): ToolDefinition[] => [
    {
      name: 'get_rate',
      description: 'The only legitimate source of a price. Returns per-night rates for one room type.',
      input_schema: {
        type: 'object',
        properties: {
          check_in: { type: 'string' },
          check_out: { type: 'string' },
          room_type: { type: 'string', enum: property.room_types.map((r) => r.name) },
        },
        required: ['check_in', 'check_out', 'room_type'],
      },
    },
    {
      name: 'send_booking_link',
      description: 'Produce the direct booking link, pre-filled with their dates.',
      input_schema: { type: 'object', properties: { check_in: { type: 'string' }, check_out: { type: 'string' } } },
    },
    {
      name: 'escalate_to_owner',
      description: 'Hand the enquiry to the hotel. Call this whenever the dossier does not answer it.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['unknown_fact', 'availability', 'rate_request', 'group', 'other'] },
          summary: { type: 'string' },
        },
        required: ['reason', 'summary'],
      },
    },
  ],

  runTool: async (property, _config, name, input: any, state) => {
    switch (name) {
      case 'get_rate': {
        const rate = property.rates?.[input.room_type];
        return rate ? { known: true, room_type: input.room_type, nightly: rate } : { known: false };
      }
      case 'send_booking_link': {
        const u = new URL(property.booking.direct_url);
        if (input.check_in) u.searchParams.set('checkin', input.check_in);
        if (input.check_out) u.searchParams.set('checkout', input.check_out);
        return { url: u.toString() };
      }
      case 'escalate_to_owner':
        state.escalations.push({ at: new Date().toISOString(), ...input });
        return { delivered: true };
      default:
        return { error: `No such tool: ${name}` };
    }
  },

  guards: [
    guards.notEmpty(),
    guards.unauthorisedNumbers('unauthorised_price', {
      from: (ctx) => [ctx.toolResults, ctx.document?.facts ?? {}],
    }),
    confirmedBooking,
    guards.paymentDetails(),
    italianLeak,
    guards.wrongScript(),
    guards.hedging(),
  ],

  // A price nobody authorised or a booking wrongly confirmed is a different
  // kind of problem from a hedge, and the queue should say so.
  grave: ['unauthorised_price', 'confirmed_booking', 'payment_detail'],
  graveLabel: 'DO NOT SEND',
});
