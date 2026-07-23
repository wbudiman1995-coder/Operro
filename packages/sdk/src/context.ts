/**
 * Platform Context (Rule 59).
 *
 * The application-tier equivalent of PostgreSQL's session context. Every
 * repository, service, resolver, RPC endpoint, Edge Function, and automation
 * receives the SAME object, so authorization questions are asked the same way
 * everywhere and independently of transport (Rule 44).
 *
 * These checks are a UX pre-filter. The database RLS layer remains the final
 * authority (Rule 56): a passing context check still hits DB policies.
 */
import type {
  BranchId,
  MembershipId,
  OrganizationId,
  UserId,
} from "./ids.js";
import type { PermissionKey } from "./constants/permissions.js";
import type { ModuleKey } from "./constants/modules.js";
import type { FeatureKey } from "./constants/features.js";
import type { CurrencyCode } from "./domain/common.js";
import { AuthorizationError } from "./errors.js";
import { ok, err, type Result } from "./result.js";

export type Transport =
  | "web"
  | "mobile"
  | "api"
  | "ai"
  | "automation"
  | "cli"
  | "job";

export interface RequestMetadata {
  readonly transport: Transport;
  readonly requestId?: string;
  readonly at: Date;
}

export interface PlatformContext {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly branchId?: BranchId;
  readonly membershipId?: MembershipId;
  readonly isPlatformAdmin: boolean;
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly modules: ReadonlySet<ModuleKey>;
  readonly features: ReadonlySet<FeatureKey>;
  readonly branches: ReadonlySet<BranchId>;
  readonly metadata: RequestMetadata;
}

export const hasMembership = (ctx: PlatformContext): boolean =>
  ctx.isPlatformAdmin || ctx.membershipId !== undefined;

export const can = (ctx: PlatformContext, permission: PermissionKey): boolean =>
  ctx.isPlatformAdmin || ctx.permissions.has(permission);

export const hasModule = (ctx: PlatformContext, module: ModuleKey): boolean =>
  ctx.isPlatformAdmin || ctx.modules.has(module);

export const hasFeature = (ctx: PlatformContext, feature: FeatureKey): boolean =>
  ctx.isPlatformAdmin || ctx.features.has(feature);

export const hasBranch = (ctx: PlatformContext, branch: BranchId): boolean =>
  ctx.isPlatformAdmin ||
  ctx.permissions.has("branches.all" as PermissionKey) ||
  ctx.branches.has(branch);

export interface AuthorizeRequest {
  readonly module?: ModuleKey;
  readonly permission?: PermissionKey;
  readonly branch?: BranchId;
}

/**
 * Mirror of `app.explain_authorization`. Evaluates the additive layers in the
 * same order as the database (Rule 43) and returns the first failing reason,
 * so denials are explainable identically on both sides (Rules 47/53).
 */
export function authorize(
  ctx: PlatformContext,
  req: AuthorizeRequest,
): Result<true, AuthorizationError> {
  if (ctx.isPlatformAdmin) return ok(true);
  if (!hasMembership(ctx)) return err(new AuthorizationError("no_active_membership"));
  if (req.module && !hasModule(ctx, req.module))
    return err(new AuthorizationError(`missing_module:${req.module}`));
  if (req.branch && !hasBranch(ctx, req.branch))
    return err(new AuthorizationError("wrong_branch"));
  if (req.permission && !can(ctx, req.permission))
    return err(new AuthorizationError(`missing_permission:${req.permission}`));
  return ok(true);
}

/**
 * Resolution Context (ADR-002) — the deterministic input a commercial
 * resolver receives, derived from the broader Platform Context.
 */
export interface ResolutionContext {
  readonly organizationId: OrganizationId;
  readonly branchId?: BranchId;
  readonly at: Date;
  readonly currency: CurrencyCode;
}

export function toResolutionContext(
  ctx: PlatformContext,
  extra: { currency: CurrencyCode; at?: Date; branchId?: BranchId },
): ResolutionContext {
  return {
    organizationId: ctx.organizationId,
    at: extra.at ?? ctx.metadata.at,
    currency: extra.currency,
    ...(extra.branchId ?? ctx.branchId
      ? { branchId: (extra.branchId ?? ctx.branchId) as BranchId }
      : {}),
  };
}
