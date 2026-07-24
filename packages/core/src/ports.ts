export interface AuthenticationProvider {
  authenticate(token: string): Promise<{ id: string; displayName: string; roles: string[] } | null>;
}

export interface DeploymentProvider {
  plan(): Promise<Array<{ action: string; target: string; destructive: boolean }>>;
  deploy(): Promise<{ url: string; deploymentId: string }>;
  verify(): Promise<{ healthy: boolean; details: string[] }>;
}

export interface McpTransportConfiguration {
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

export interface SourceRepositoryInspector {
  search(query: string): Promise<Array<{ path: string; line: number; text: string }>>;
  recentChanges(
    since: string,
  ): Promise<Array<{ commit: string; subject: string; files: string[] }>>;
}
