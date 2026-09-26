/** Raw → normalized schemas for the REST responses (see ./types.ts). */
import { z } from 'zod';
import {
  decimalString,
  safeInt,
  secondsField,
  secondsOrZeroAsNull,
} from '../core/schema.js';
import type { UnixMillis } from '../core/time.js';
import type { CreatorHistory, TokenIdentity, TokenSecurity } from './types.js';

export function securitySchema(fetchedAt: UnixMillis) {
  return z
    .object({
      mint: z.string(),
      mint_authority: z.string().nullable(),
      freeze_authority: z.string().nullable(),
      token2022: z.boolean(),
      metadata_mutable: z.boolean().nullable(),
      extensions: z.array(z.string()),
      transfer_fee_pct: decimalString.nullable(),
      non_transferable: z.boolean(),
      total_tax_pct: decimalString,
      tax_breakdown: z.object({
        transfer_fee_pct: decimalString,
        swap_fee_pct: decimalString,
        tip_pct: decimalString,
      }),
      creator: z.string(),
      creator_pct: decimalString,
      top10_pct: decimalString,
    })
    .transform(
      (r): TokenSecurity => ({
        mint: r.mint,
        mintAuthority: r.mint_authority,
        freezeAuthority: r.freeze_authority,
        token2022: r.token2022,
        metadataMutable: r.metadata_mutable,
        extensions: r.extensions,
        transferFeePct: r.transfer_fee_pct,
        nonTransferable: r.non_transferable,
        totalTaxPct: r.total_tax_pct,
        taxBreakdown: {
          transferFeePct: r.tax_breakdown.transfer_fee_pct,
          swapFeePct: r.tax_breakdown.swap_fee_pct,
          tipPct: r.tax_breakdown.tip_pct,
        },
        creator: r.creator,
        creatorPct: r.creator_pct,
        top10Pct: r.top10_pct,
        fetchedAt,
      }),
    );
}

export interface DevHistoryResult {
  /** Identity of the queried mint (the only one whose `launchpad` is known). */
  readonly queried: TokenIdentity;
  readonly history: CreatorHistory;
}

export function devHistorySchema(fetchedAt: UnixMillis) {
  return z
    .object({
      mint: z.string(),
      creator: z.string(),
      launchpad: z.string(),
      created_time: secondsField,
      tokens_launched: safeInt,
      migrated: safeInt,
      first_launch: secondsField,
      last_launch: secondsField,
      scanned: safeInt,
      truncated: z.boolean(),
      tokens: z.array(
        z.object({
          mint: z.string(),
          name: z.string(),
          symbol: z.string(),
          dex: z.string(),
          created_time: secondsField,
          graduated: z.boolean(),
          graduated_time: secondsOrZeroAsNull,
          // null for some tokens (9 of 52 real answers on 2026-09-26 failed on this).
          ath_usd: decimalString.nullable(),
          ath_mcap_usd: decimalString.nullable(),
          price_usd: decimalString,
          liquidity_usd: decimalString,
          holders: safeInt,
          total_fees_usd: decimalString,
          volume_1h_usd: decimalString,
          bundlers_count: safeInt,
          is_current: z.boolean(),
        }),
      ),
    })
    .transform((r): DevHistoryResult => {
      const current = r.tokens.find((t) => t.mint === r.mint);
      return {
        queried: {
          mint: r.mint,
          creator: r.creator,
          createdTime: r.created_time,
          launchpad: r.launchpad,
          name: current?.name ?? null,
          symbol: current?.symbol ?? null,
        },
        history: {
          creator: r.creator,
          tokensLaunched: r.tokens_launched,
          migrated: r.migrated,
          firstLaunch: r.first_launch,
          lastLaunch: r.last_launch,
          scanned: r.scanned,
          truncated: r.truncated,
          tokens: r.tokens.map((t) => ({
            mint: t.mint,
            name: t.name,
            symbol: t.symbol,
            dex: t.dex,
            createdTime: t.created_time,
            graduated: t.graduated,
            graduatedTime: t.graduated_time,
            athUsd: t.ath_usd,
            athMcapUsd: t.ath_mcap_usd,
            priceUsd: t.price_usd,
            liquidityUsd: t.liquidity_usd,
            holders: t.holders,
            totalFeesUsd: t.total_fees_usd,
            volume1hUsd: t.volume_1h_usd,
            bundlersCount: t.bundlers_count,
            isCurrent: t.is_current,
          })),
          fetchedAt,
        },
      };
    });
}
