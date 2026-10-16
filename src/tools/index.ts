// Single registry of all tools exposed by this MCP server. Keep this file
// short — adding a new tool = import + push.

import type { ToolDefinition } from './types.js';
import {
  listCatalogProducts,
  getCatalogPlan,
  listRegions,
  listImages,
  getProductDetails,
  listPrepurchaseOsTemplates,
  listCatalogListings,
  listKubernetesVersions,
} from './catalog.js';
import {
  listServices,
  getService,
  getServiceMetrics,
  listBackups,
  getProvisioningState,
  listOsTemplates,
  listUpgradeOptions,
  getServiceIso,
  listServiceSshKeyLibrary,
  getServiceAutorenew,
} from './services.js';
import { listOrders, getOrder } from './orders.js';
import {
  listInvoices,
  getInvoice,
  getCreditBalance,
  getCreditLedger,
  getInvoicePayPreview,
  listPaymentMethods,
  getBillingCampaign,
  getBonusBalance,
  getBonusLedger,
  getBillingAlert,
  getBillingState,
} from './billing.js';
import {
  getAccount,
  listSshKeys,
  getAccountLimits,
  listAccountClients,
  getAffiliate,
  getTwoFactorStatus,
  listAccountSshKeys,
  getAccountActivity,
  listAccountEmails,
  listAccountContacts,
} from './account.js';
import { listTickets, getTicket, listTicketDepartments } from './tickets.js';
import {
  listVolumes,
  getVolume,
  listNetworks,
  getNetwork,
  listLoadBalancers,
  getLoadBalancer,
  listLoadBalancerMembers,
  listReservedIps,
  listFirewalls,
  getFirewall,
} from './infra.js';
import {
  listDomains,
  getDomain,
  checkDomainAvailability,
  getTldPricing,
  getDomainNameservers,
  getDomainContacts,
  getDomainDns,
  getDomainManagement,
} from './domains.js';
import {
  getClusterScale,
  listClusterPools,
  getClusterKubeconfig,
  listClusterKubeconfigs,
  downloadClusterKubeconfig,
} from './k8s.js';
import {
  listProxies,
  getProxyCatalog,
  getProxy,
  getProxyList,
  getProxyAuth,
  listGbResidentialCountries,
  listGbRotationIntervals,
  listProxyRequests,
  getProxyRequestList,
  getProxyReplacements,
} from './proxies.js';
import {
  setServiceHostname,
  deployService,
  destroyService,
  resizeService,
  upgradeService,
  renewService,
  cancelService,
  setServiceAutorenew,
  createServiceBackup,
  mountServiceIso,
  unmountServiceIso,
  setServicePassword,
  startService,
  stopService,
  rebootService,
  reinstallService,
  resetServicePassword,
  addServiceSshKey,
  addServiceSshKeyToLibrary,
  applyServiceSshKeyLibrary,
  setServiceTags,
  checkOrder,
} from './services-write.js';
import { listApiAccess } from './api-access.js';
import {
  setClusterScale,
  addClusterPool,
  updateClusterPool,
  deleteClusterPool,
  renameClusterPool,
  enableClusterHa,
  createClusterKubeconfig,
  revokeClusterKubeconfig,
} from './k8s-write.js';
import {
  createVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  createNetwork,
  deleteNetwork,
  attachNetworkVm,
  reserveIp,
  releaseReservedIp,
  attachReservedIp,
  detachReservedIp,
} from './infra-write.js';
import {
  createFirewall,
  deleteFirewall,
  addFirewallRule,
  deleteFirewallRule,
  attachFirewall,
  detachFirewall,
  createLoadBalancer,
  deleteLoadBalancer,
  addLoadBalancerMember,
  removeLoadBalancerMember,
} from './firewall-lb-write.js';
import {
  registerDomain,
  transferDomain,
  renewDomain,
  setDomainNameservers,
  setDomainContacts,
  setDomainDns,
  manageDomain,
} from './domains-write.js';
import {
  updateAccount,
  addAccountSshKey,
  deleteAccountSshKey,
  resendEmailVerification,
  manageAccountContact,
  createAffiliateLink,
} from './account-write.js';
import {
  getObjectStorage,
  listObjectStorageRegions,
  getObjectStorageUsage,
  listBuckets,
  getBucket,
  getBucketUsage,
  listObjectStorageKeys,
} from './object-storage.js';
import {
  enableObjectStorage,
  disableObjectStorage,
  createBucket,
  updateBucket,
  deleteBucket,
  createObjectStorageKey,
  deleteObjectStorageKey,
} from './object-storage-write.js';
import { setBillingAlert, deleteBillingAlert, redeemVoucher } from './billing-write.js';
import { createTicket, replyTicket, closeTicket } from './tickets-write.js';
import {
  orderProxy,
  renewProxy,
  setProxyAutoRenew,
  cancelProxy,
  setProxyAuthMethod,
  setProxyCredentials,
  addProxyWhitelistedIp,
  removeProxyWhitelistedIp,
  requestProxyReplacement,
  createProxyRequest,
  deleteProxyRequest,
} from './proxies-write.js';
import {
  listSandboxes,
  getSandbox,
  listSandboxTemplates,
  readSandboxFile,
  getSandboxLogs,
} from './sandboxes.js';
import {
  createSandbox,
  deleteSandbox,
  runSandboxCode,
  runSandboxCommand,
  writeSandboxFile,
} from './sandboxes-write.js';
import { listSnapshots, listServiceSnapshots, getSnapshot } from './snapshots.js';
import { createSnapshot, deleteSnapshot, restoreSnapshot } from './snapshots-write.js';
import { getQuotaLimits, estimateLimits, listQuotaRequests } from './limits.js';
import { requestQuotaIncrease } from './limits-write.js';
import { getServiceRdns } from './rdns.js';
import { setServiceRdns, deleteServiceRdns } from './rdns-write.js';

export const TOOLS: ToolDefinition[] = [
  // Catalog (un-authed surface, "what can I deploy?")
  listCatalogProducts,
  getCatalogPlan,
  listRegions,
  listImages,
  getProductDetails,
  listPrepurchaseOsTemplates,
  listCatalogListings,
  listKubernetesVersions,
  // Services ("what do I have running?")
  listServices,
  getService,
  getServiceMetrics,
  listBackups,
  getProvisioningState,
  listOsTemplates,
  listUpgradeOptions,
  getServiceIso,
  listServiceSshKeyLibrary,
  getServiceAutorenew,
  checkOrder, // read-only POST /v1/services/preflight: would deploy_service be accepted?
  // Orders ("what have I purchased?")
  listOrders,
  getOrder,
  // Billing ("how much am I spending?")
  listInvoices,
  getInvoice,
  getCreditBalance,
  getCreditLedger,
  getInvoicePayPreview,
  listPaymentMethods,
  getBillingCampaign,
  getBonusBalance,
  getBonusLedger,
  getBillingAlert,
  getBillingState,
  // Support ("any open tickets?")
  listTickets,
  getTicket,
  listTicketDepartments,
  // Account ("who am I + what are my keys?")
  getAccount,
  listSshKeys,
  getAccountLimits,
  listAccountClients,
  getAffiliate,
  getTwoFactorStatus,
  listAccountSshKeys,
  getAccountActivity,
  listAccountEmails,
  listAccountContacts,
  listApiAccess,
  // Cloud infrastructure ("what storage / networks / LBs / IPs / firewalls do I have?")
  listVolumes,
  getVolume,
  listNetworks,
  getNetwork,
  listLoadBalancers,
  getLoadBalancer,
  listLoadBalancerMembers,
  listReservedIps,
  listFirewalls,
  getFirewall,
  // Object Storage ("what buckets / keys do I have, and what do they cost?")
  getObjectStorage,
  listObjectStorageRegions,
  getObjectStorageUsage,
  listBuckets,
  getBucket,
  getBucketUsage,
  listObjectStorageKeys,
  // Domains ("what domains do I own + is this name available?")
  listDomains,
  getDomain,
  checkDomainAvailability,
  getTldPricing,
  getDomainNameservers,
  getDomainContacts,
  getDomainDns,
  getDomainManagement,
  // Managed Kubernetes ("scale / pools / kubeconfig for my cloud-k8s clusters")
  getClusterScale,
  listClusterPools,
  getClusterKubeconfig,
  listClusterKubeconfigs,
  downloadClusterKubeconfig,
  // Proxies ("residential proxy services — ISP plans + GB Residential buckets")
  listProxies,
  getProxyCatalog,
  getProxy,
  getProxyList,
  getProxyAuth,
  listGbResidentialCountries,
  listGbRotationIntervals,
  listProxyRequests,
  getProxyRequestList,
  getProxyReplacements,
  // AI Sandboxes ("what sandboxes are running, what do templates cost, read a file or the logs")
  listSandboxes,
  getSandbox,
  listSandboxTemplates,
  readSandboxFile,
  getSandboxLogs,
  // Snapshots ("what VM snapshots do I have?")
  listSnapshots,
  listServiceSnapshots,
  getSnapshot,
  // Quotas ("how much room is left, and can this cluster fit?")
  getQuotaLimits,
  estimateLimits, // read-only POST /v1/limits/estimate: creates and reserves nothing
  listQuotaRequests,
  // Reverse DNS
  getServiceRdns,

  // --- WRITE / ACTION TOOLS (Parity Phase B) ---
  // Services — writes
  setServiceHostname,
  // Services — writes (lifecycle / spend)
  deployService,
  destroyService,
  resizeService,
  upgradeService,
  renewService,
  cancelService,
  setServiceAutorenew,
  createServiceBackup,
  mountServiceIso,
  unmountServiceIso,
  setServicePassword,
  // Services — actions + keys
  startService,
  stopService,
  rebootService,
  reinstallService,
  resetServicePassword,
  addServiceSshKey,
  addServiceSshKeyToLibrary,
  applyServiceSshKeyLibrary,
  setServiceTags,
  // Managed Kubernetes — writes
  setClusterScale,
  addClusterPool,
  updateClusterPool,
  deleteClusterPool,
  renameClusterPool,
  enableClusterHa,
  createClusterKubeconfig,
  revokeClusterKubeconfig,
  // Cloud infra — writes (volumes / networks / reserved-ips)
  createVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  createNetwork,
  deleteNetwork,
  attachNetworkVm,
  reserveIp,
  releaseReservedIp,
  attachReservedIp,
  detachReservedIp,
  // Cloud infra — writes (firewalls / load-balancers)
  createFirewall,
  deleteFirewall,
  addFirewallRule,
  deleteFirewallRule,
  attachFirewall,
  detachFirewall,
  createLoadBalancer,
  deleteLoadBalancer,
  addLoadBalancerMember,
  removeLoadBalancerMember,
  // Object Storage writes (service / buckets / access keys)
  enableObjectStorage,
  disableObjectStorage,
  createBucket,
  updateBucket,
  deleteBucket,
  createObjectStorageKey,
  deleteObjectStorageKey,
  // Domains — writes (register / transfer / renew / nameservers / contacts / dns / manage)
  registerDomain,
  transferDomain,
  renewDomain,
  setDomainNameservers,
  setDomainContacts,
  setDomainDns,
  manageDomain,
  // Account — writes (profile / account SSH keys / verify-email / contacts / affiliate link)
  updateAccount,
  addAccountSshKey,
  deleteAccountSshKey,
  resendEmailVerification,
  manageAccountContact,
  createAffiliateLink,
  // Billing — writes (spend alert / voucher redemption — NO money movement)
  setBillingAlert,
  deleteBillingAlert,
  redeemVoucher,
  // Support — writes (open / reply / close a ticket)
  createTicket,
  replyTicket,
  closeTicket,
  // Proxies — writes (order / renew / auto-renew / cancel / auth / whitelist / replacement / GB proxy-requests)
  orderProxy,
  renewProxy,
  setProxyAutoRenew,
  cancelProxy,
  setProxyAuthMethod,
  setProxyCredentials,
  addProxyWhitelistedIp,
  removeProxyWhitelistedIp,
  requestProxyReplacement,
  createProxyRequest,
  deleteProxyRequest,
  // AI Sandboxes: writes (create / delete / run code / run a command / write a file; no port exposure)
  createSandbox,
  deleteSandbox,
  runSandboxCode,
  runSandboxCommand,
  writeSandboxFile,
  // Snapshots: writes (take / delete / restore)
  createSnapshot,
  deleteSnapshot,
  restoreSnapshot,
  // Quotas: writes (ask for a quota increase)
  requestQuotaIncrease,
  // Reverse DNS: writes
  setServiceRdns,
  deleteServiceRdns,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
