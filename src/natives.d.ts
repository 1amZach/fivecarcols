// The FiveM server natives and globals this resource uses.

declare function GetCurrentResourceName(): string;
declare function RegisterCommand(name: string, handler: (src: number, args: string[], raw: string) => void, restricted: boolean): void;

declare function GetNumResources(): number;
declare function GetResourceByFindIndex(index: number): string;
declare function GetResourceState(name: string): string;
declare function GetResourcePath(name: string): string;
declare function LoadResourceFile(name: string, path: string): string | null;
