// Single registry of all tools exposed by this MCP server. Keep this file
// short — adding a new tool = import + push.

import type { ToolDefinition } from './types.js';
import {
  listCatalogProducts,
  getCatalogPlan,
  listRegions,
  listImages,
} from './catalog.js';
import { listServices, getService, getServiceMetrics, listBackups, getProvisioningState, listOsTemplates, listUpgradeOptions } from './services.js';
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

export const TOOLS: ToolDefinition[] = [
  // Catalog (un-authed surface, "what can I deploy?")
  listCatalogProducts,
  getCatalogPlan,
  listRegions,
  listImages,
  // Services ("what do I have running?")
  listServices,
  getService,
  getServiceMetrics,
  listBackups,
  getProvisioningState,
  listOsTemplates,
  listUpgradeOptions,
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
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
