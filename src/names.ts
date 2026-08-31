const validWorkspaceName = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$/;

export function validateWorkspaceName(name: string): string {
  if (!isValidWorkspaceName(name)) {
    throw new Error('Workspace name must use 1-63 lowercase letters, numbers, or single hyphens, and begin with a letter or number.');
  }
  return name;
}

export function isValidWorkspaceName(name: string): boolean {
  return validWorkspaceName.test(name);
}
