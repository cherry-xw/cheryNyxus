// The startup template tool and both services must use the same lock and CAS implementation.
export {
  configRevision,
  replaceConfigText,
  transactionExpectedText,
  withConfigTransaction,
  withConfigTransactionSync,
} from '../../../../scripts/lib/config-transaction.mjs'
