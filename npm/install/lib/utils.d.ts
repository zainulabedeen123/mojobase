interface McpConfig {
    mcpServers?: Record<string, unknown>;
    [key: string]: unknown;
}
export declare const logger: import("consola").ConsolaInstance;
export declare const clientNames: string[];
export declare function readConfig(client: string, local?: boolean): McpConfig;
export declare function writeConfig(config: McpConfig, client: string, local?: boolean): void;
export {};
