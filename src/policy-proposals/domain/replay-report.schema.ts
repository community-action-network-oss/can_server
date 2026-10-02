// Copy of can_policy schemas/replay-report.schema.json (test/policy-proposals asserts it equals the fixture copy).
export const REPLAY_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'replay-report.schema.json',
  title: 'Replay diff report (tools/replay.mjs --json)',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'verdict',
    'bump',
    'limits',
    'totals',
    'by_direction',
    'by_dp',
    'by_rule',
    'by_jurisdiction',
    'dp_stats',
    'flips',
    'blockers',
    'warnings',
    'remoderation',
  ],
  properties: {
    schema_version: {
      const: 1,
    },
    verdict: {
      enum: ['ok', 'needs_review', 'blocked', 'no_data'],
    },
    bump: {
      enum: ['patch', 'minor', 'major'],
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['minor_flip_pct', 'cost_per_run'],
      properties: {
        minor_flip_pct: {
          type: 'number',
          minimum: 0,
        },
        cost_per_run: {
          type: 'number',
          minimum: 0,
        },
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: [
        'decisions',
        'flips',
        'expected',
        'unintended',
        'protected_flips',
      ],
      properties: {
        decisions: {
          type: 'integer',
          minimum: 0,
        },
        flips: {
          type: 'integer',
          minimum: 0,
        },
        expected: {
          type: 'integer',
          minimum: 0,
        },
        unintended: {
          type: 'integer',
          minimum: 0,
        },
        protected_flips: {
          type: 'integer',
          minimum: 0,
        },
      },
    },
    by_direction: {
      type: 'object',
      additionalProperties: false,
      required: ['stricter', 'more_permissive', 'lateral'],
      properties: {
        stricter: {
          type: 'integer',
          minimum: 0,
        },
        more_permissive: {
          type: 'integer',
          minimum: 0,
        },
        lateral: {
          type: 'integer',
          minimum: 0,
        },
      },
    },
    by_dp: {
      $ref: '#/$defs/buckets',
    },
    by_rule: {
      $ref: '#/$defs/buckets',
    },
    by_jurisdiction: {
      $ref: '#/$defs/buckets',
    },
    dp_stats: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['decisions', 'flips', 'flip_pct'],
        properties: {
          decisions: {
            type: 'integer',
            minimum: 0,
          },
          flips: {
            type: 'integer',
            minimum: 0,
          },
          flip_pct: {
            type: 'number',
            minimum: 0,
            maximum: 100,
          },
        },
      },
    },
    flips: {
      type: 'array',
      items: {
        $ref: '#/$defs/flip',
      },
    },
    blockers: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    remoderation: {
      type: 'object',
      additionalProperties: false,
      required: ['volume', 'estimated_cost'],
      properties: {
        volume: {
          type: 'integer',
          minimum: 0,
        },
        estimated_cost: {
          type: 'number',
          minimum: 0,
        },
      },
    },
  },
  $defs: {
    buckets: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['flips', 'stricter', 'more_permissive', 'lateral'],
        properties: {
          flips: {
            type: 'integer',
            minimum: 0,
          },
          stricter: {
            type: 'integer',
            minimum: 0,
          },
          more_permissive: {
            type: 'integer',
            minimum: 0,
          },
          lateral: {
            type: 'integer',
            minimum: 0,
          },
        },
      },
    },
    side: {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'rule_ids'],
      properties: {
        outcome: {
          type: 'string',
        },
        rule_ids: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
    flip: {
      type: 'object',
      additionalProperties: false,
      required: [
        'decision_id',
        'dp',
        'jurisdiction',
        'stratum',
        'field_ref',
        'from',
        'to',
        'direction',
        'label',
        'protected',
        'confidence_delta',
      ],
      properties: {
        decision_id: {
          type: 'string',
        },
        dp: {
          type: 'string',
        },
        jurisdiction: {
          type: 'string',
        },
        stratum: {
          type: ['string', 'null'],
        },
        field_ref: {
          type: ['object', 'null'],
        },
        from: {
          $ref: '#/$defs/side',
        },
        to: {
          $ref: '#/$defs/side',
        },
        direction: {
          enum: ['stricter', 'more_permissive', 'lateral'],
        },
        label: {
          enum: ['expected', 'unintended'],
        },
        protected: {
          type: 'boolean',
        },
        confidence_delta: {
          type: 'number',
        },
      },
    },
  },
} as const;
