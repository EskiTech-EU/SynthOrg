'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Average price calculation and sorting handles input and output appropriately', () => {
  function getModelAveragePrice(m) {
    if (!m || !m.pricing) return -1;
    if (m.isAutoRouter || m.isFusionRouter || m.pricing.isAutoRouter || m.pricing.isFusionRouter) return -1;
    const pIn = typeof m.pricing.promptPerM === 'number' ? m.pricing.promptPerM : -1;
    const pOut = typeof m.pricing.completionPerM === 'number' ? m.pricing.completionPerM : -1;
    if (pIn < 0 && pOut < 0) return -1;
    if (pIn < 0) return pOut;
    if (pOut < 0) return pIn;
    return (pIn + pOut) / 2;
  }

  const modelA = { id: 'a', name: 'Model A', pricing: { promptPerM: 10, completionPerM: 10 } }; // avg = 10
  const modelB = { id: 'b', name: 'Model B', pricing: { promptPerM: 2, completionPerM: 20 } };  // avg = 11 (previously prompt 2 ranked before A!)
  const modelC = { id: 'c', name: 'Model C', pricing: { promptPerM: 0, completionPerM: 0 } };   // avg = 0 (free)
  const modelD = { id: 'd', name: 'Model D', pricing: { promptPerM: 5, completionPerM: 5 } };   // avg = 5 (assigned model)

  assert.equal(getModelAveragePrice(modelA), 10);
  assert.equal(getModelAveragePrice(modelB), 11);
  assert.equal(getModelAveragePrice(modelC), 0);
  assert.equal(getModelAveragePrice(modelD), 5);

  const assignedModelId = 'd';
  const list = [modelB, modelA, modelD, modelC];

  // Price Ascending Sort with assigned model pinned first
  list.sort((a, b) => {
    if (assignedModelId) {
      if (a.id === assignedModelId) return -1;
      if (b.id === assignedModelId) return 1;
    }
    const avgA = getModelAveragePrice(a);
    const avgB = getModelAveragePrice(b);
    if (avgA >= 0 && avgB >= 0) return avgA - avgB;
    if (avgA < 0 && avgB >= 0) return 1;
    if (avgA >= 0 && avgB < 0) return -1;
    return a.name.localeCompare(b.name);
  });

  assert.equal(list[0].id, 'd', 'Assigned model should be pinned first');
  assert.equal(list[1].id, 'c', 'Free model (avg $0) should come next');
  assert.equal(list[2].id, 'a', 'Model A (avg $10) should come before Model B (avg $11)');
  assert.equal(list[3].id, 'b', 'Model B (avg $11) should come after Model A');
});

test('Pagination slicing and page count correctly computes chunks', () => {
  const totalItems = 356;
  const pageSize = 25;
  const totalPages = Math.ceil(totalItems / pageSize);

  assert.equal(totalPages, 15, '356 items at 25/page should have 15 pages');

  // Page 1
  let page = 1;
  let start = (page - 1) * pageSize;
  let end = Math.min(start + pageSize, totalItems);
  assert.equal(start, 0);
  assert.equal(end, 25);

  // Page 15 (last page)
  page = 15;
  start = (page - 1) * pageSize;
  end = Math.min(start + pageSize, totalItems);
  assert.equal(start, 350);
  assert.equal(end, 356);
  assert.equal(end - start, 6, 'Last page should have 6 items');
});
