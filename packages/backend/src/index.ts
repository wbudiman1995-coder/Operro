/**
 * @operro/backend — public surface.
 * Grooming BookingAssembly: infra ports, repository over the approved RPCs, and
 * the business service. Consumes @operro/sdk (contract) + @operro/preset-grooming
 * (operation contract).
 */
export * from "./infra/index.js";
export * from "./repositories/grooming.js";
export * from "./services/BookingAssemblyService.js";
