/**
 * The HTTP contract, re-exported.
 *
 * The schemas themselves moved to `@tr4ce/domain` once the web app needed to parse responses
 * through them. Kept as a module here so the routes, the OpenAPI generator and the services keep
 * their existing import path, and so the contract still reads as belonging to this app.
 */

export * from "@tr4ce/domain/contract";
