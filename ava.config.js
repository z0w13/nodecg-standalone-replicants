export default {
  files: [
    'test/**',
    '!test/helpers/**',
    '!test/fixtures/**'
  ],
  concurrency: 1,
  timeout: '2m',
  verbose: true
}
