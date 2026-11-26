// Modules that vite.config.ts makes while building.
declare module "virtual:changelog" {
  const releases: import("../../shared/types").Release[];
  export default releases;
}
