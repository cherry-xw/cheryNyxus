export function transactionExpectedText(file: string): string
export function configRevision(text: string): string
export function withConfigTransactionSync<T>(file: string, operation: () => T): T
export function withConfigTransaction<T>(file: string, operation: () => Promise<T>): Promise<T>
export function replaceConfigText(file: string, text: string, expectedText: string): void
