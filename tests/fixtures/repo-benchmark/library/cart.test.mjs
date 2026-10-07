import assert from 'node:assert/strict';
import test from 'node:test';
import { cartTotal } from './cart.mjs';

test('an empty cart costs zero', () => assert.equal(cartTotal([]), 0));
test('one item costs its unit price', () => assert.equal(cartTotal([{ unitPrice: 1250, quantity: 1 }]), 1250));
test('the cart total includes every quantity', () => assert.equal(cartTotal([{ unitPrice: 1250, quantity: 3 }]), 3750));
