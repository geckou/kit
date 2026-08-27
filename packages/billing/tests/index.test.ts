import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME } from '../src/index.js'

describe('package smoke test', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@geckou/billing')
  })
})
