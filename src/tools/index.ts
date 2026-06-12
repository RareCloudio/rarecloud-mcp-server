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
import { listInvoices, getInvoice, getCreditBalance, getCreditLedger } from './billing.js';
import { getAccount, listSshKeys, getAccountLimits } from './account.js';
import { listTickets, getTicket } from './tickets.js';

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
  // Support ("any open tickets?")
  listTickets,
  getTicket,
  // Account ("who am I + what are my keys?")
  getAccount,
  listSshKeys,
  getAccountLimits,
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
