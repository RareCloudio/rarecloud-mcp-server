// Unit tests for the catalog read tools added in Parity Phase A / Task 3
// (product details, pre-purchase OS templates, deploy-wizard listings, managed
// K8s versions). Fake client records the constructed path; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProductDetails,
  listPrepurchaseOsTemplates,
  listCatalogListings,
  listKubernetesVersions,
} from './catalog.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

function fakeClient(onGet: (path: string) => unknown): { client: RareCloudClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async get(path: string) {
      calls.push(path);
      return onGet(path);
    },
  } as unknown as RareCloudClient;
  return { client, calls };
}

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

// --- list_kubernetes_versions (no input) ----------------------------------

test('catalog: list_kubernetes_versions — name, GETs the fixed path, non-empty description', async () => {
  assert.equal(listKubernetesVersions.name, 'list_kubernetes_versions');
  assert.ok(listKubernetesVersions.description.trim().length > 0);
  const { client, calls } = fakeClient(() => ({ versions: [] }));
  const result = await listKubernetesVersions.handler(client, {});
  assert.deepEqual(calls, ['/v1/catalog/kubernetes-versions']);
  assert.equal(result.isError, undefined);
});

// --- get_product_details ({sku}/details) ----------------------------------

test('catalog: get_product_details — encodes sku into the /details sub-path', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await getProductDetails.handler(client, { sku: 'whmcs.kvm/plus vps' });
  assert.deepEqual(calls, ['/v1/catalog/products/whmcs.kvm%2Fplus%20vps/details']);
});

test('catalog: get_product_details — requires sku (closed schema, only sku)', () => {
  assert.equal(getProductDetails.name, 'get_product_details');
  assert.deepEqual(getProductDetails.inputSchema.required, ['sku']);
  assert.equal(getProductDetails.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getProductDetails.inputSchema.properties), ['sku']);
});

test('catalog: get_product_details — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such product' });
  });
  const result = await getProductDetails.handler(client, { sku: 'x' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such product');
});

// --- list_prepurchase_os_templates ({sku}/os-templates) -------------------

test('catalog: list_prepurchase_os_templates — encodes sku into the /os-templates sub-path', async () => {
  const { client, calls } = fakeClient(() => ({ templates: [] }));
  await listPrepurchaseOsTemplates.handler(client, { sku: 'a/b c' });
  assert.deepEqual(calls, ['/v1/catalog/products/a%2Fb%20c/os-templates']);
});

test('catalog: list_prepurchase_os_templates — requires sku (closed schema, only sku)', () => {
  assert.equal(listPrepurchaseOsTemplates.name, 'list_prepurchase_os_templates');
  assert.deepEqual(listPrepurchaseOsTemplates.inputSchema.required, ['sku']);
  assert.equal(listPrepurchaseOsTemplates.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(listPrepurchaseOsTemplates.inputSchema.properties), ['sku']);
});

// --- list_catalog_listings ({category}) -----------------------------------

test('catalog: list_catalog_listings — puts a normal category verbatim in the path', async () => {
  const { client, calls } = fakeClient(() => ([]));
  await listCatalogListings.handler(client, { category: 'cloud-vm' });
  assert.deepEqual(calls, ['/v1/catalog/listings/cloud-vm']);
});

test('catalog: list_catalog_listings — encodes the category segment', async () => {
  const { client, calls } = fakeClient(() => ([]));
  await listCatalogListings.handler(client, { category: 'a b' });
  assert.deepEqual(calls, ['/v1/catalog/listings/a%20b']);
});

test('catalog: list_catalog_listings — requires category, exposes the documented enum', () => {
  assert.equal(listCatalogListings.name, 'list_catalog_listings');
  assert.deepEqual(listCatalogListings.inputSchema.required, ['category']);
  assert.equal(listCatalogListings.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(listCatalogListings.inputSchema.properties), ['category']);
  const category = listCatalogListings.inputSchema.properties.category as { enum?: string[] };
  assert.deepEqual(category.enum, [
    'cloud-vm',
    'cloud-k8s',
    'cloud-volume',
    'cloud-network',
    'cloud-loadbalancer',
    'cloud-reserved-ip',
    'server',
    'hosting',
    'proxy',
    'domain',
  ]);
});
