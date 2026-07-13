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
  getVpanelStatus,
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
import { listVolumes, listNetworks, listLoadBalancers, getLoadBalancer, listReservedIps, listDomains, getDomain } from './infra.js';
import {
  getClusterScale,
  listClusterPools,
  getClusterKubeconfig,
  listClusterKubeconfigs,
  downloadClusterKubeconfig,
} from './k8s.js';

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
  getVpanelStatus,
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
  // Cloud infrastructure ("what storage / networks / IPs / domains do I have?")
  listVolumes,
  listNetworks,
  listLoadBalancers,
  getLoadBalancer,
  listReservedIps,
  listDomains,
  getDomain,
  // Managed Kubernetes ("scale / pools / kubeconfig for my cloud-k8s clusters")
  getClusterScale,
  listClusterPools,
  getClusterKubeconfig,
  listClusterKubeconfigs,
  downloadClusterKubeconfig,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
