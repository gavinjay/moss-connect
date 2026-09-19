module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', {}] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
};
