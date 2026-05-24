// tests/docScenarios.js
// Document test scenarios — select with DOC_TEST_SCENARIO=techcorp|product-brief

const SCENARIOS = {
  techcorp: {
    id: 'techcorp',
    label: 'TechCorp Q3 Performance Report',
    outputBasename: 'techcorp_q3_report.docx',
    request: `Write a detailed, content-rich business report for "TechCorp Q3 2024 Performance Review".
This must be a FULL multi-page document with SUBSTANTIAL content — not summaries.

Required sections (each must have real depth):
1. Executive Summary — 3 substantial paragraphs (150+ words each) covering company overview, Q3 highlights, and strategic outlook
2. Financial Highlights — a properly formatted table with Revenue, Operating Expenses, Gross Profit, Net Income, and EBITDA for Q1/Q2/Q3 2024 (use realistic dollar figures in millions). Add 2 paragraphs of financial analysis below the table.
3. Product Performance — cover 3 products (TechCore Platform, CloudSync Pro, SecureShield AI). For each: 2-sentence description, key metrics table (MAU, Revenue, Growth%), one paragraph of analysis.
4. Team & Headcount — table with 6 departments (Engineering, Sales, Marketing, Support, Finance, Operations) showing headcount, Q2→Q3 change, and headcount cost. Add a paragraph about hiring strategy.
5. Key Risks & Mitigations — at least 5 risks. For each: risk name (bold), 2-sentence description, mitigation strategy bullet points.
6. Goals for Q4 2024 — numbered list of 8 concrete, specific goals with measurable targets (e.g. "Increase MRR by 18% to reach $4.2M by Dec 2024").
7. Conclusion — 2 solid closing paragraphs.

Formatting requirements:
- Use Heading 1 for all section titles, Heading 2 for sub-sections
- Bold all table headers and key terms
- Every paragraph must be 2-4 sentences of REAL content (no filler like "This is important.")
- Professional business language throughout`,
    planSections: [
      {
        name: 'executive_summary',
        functionName: 'buildExecutiveSummary',
        sectionHeading: 'Executive Summary',
        description:
          'Executive Summary: Heading 1, three substantial paragraphs (company overview, Q3 highlights, strategic outlook).',
      },
      {
        name: 'financial_highlights',
        functionName: 'buildFinancialHighlights',
        sectionHeading: 'Financial Highlights',
        description:
          'Financial Highlights: Heading 1, use helpers.createTable for the financial table (Q1–Q3), two paragraphs of analysis.',
      },
      {
        name: 'product_performance',
        functionName: 'buildProductPerformance',
        sectionHeading: 'Product Performance',
        description:
          'Product Performance: TechCore Platform, CloudSync Pro, SecureShield AI — use helpers.createTable per product metrics, analysis paragraphs.',
      },
      {
        name: 'team_headcount',
        functionName: 'buildTeamHeadcount',
        sectionHeading: 'Team & Headcount',
        description:
          'Team & Headcount: helpers.createTable for 6 departments, hiring-strategy paragraph.',
      },
      {
        name: 'risks_mitigations',
        functionName: 'buildRisksAndMitigations',
        sectionHeading: 'Key Risks & Mitigations',
        description:
          'At least five risks with bold titles, descriptions, use helpers.createBulletList for mitigations.',
      },
      {
        name: 'goals_q4',
        functionName: 'buildGoalsQ4',
        sectionHeading: 'Goals for Q4 2024',
        description:
          'Use helpers.createNumberedList for eight concrete Q4 goals with measurable targets.',
      },
      {
        name: 'conclusion',
        functionName: 'buildConclusion',
        sectionHeading: 'Conclusion',
        description: 'Conclusion: two closing paragraphs.',
      },
    ],
  },

  'product-brief': {
    id: 'product-brief',
    label: 'Nova Smart Hub — Product Launch Brief',
    outputBasename: 'nova_smart_hub_launch.docx',
    request: `Create a professional product launch brief for "Nova Smart Hub" — a smart home controller launching Q1 2026.

Required sections:
1. Product Overview — 2 paragraphs explaining what Nova Smart Hub is, target customer (busy homeowners), and core value proposition (one app, all devices).
2. Key Features — Heading 2 for each of 4 features: Voice Control, Energy Insights, Security Automations, Family Profiles. Each feature: 1 bold title line, 2 sentences of detail, one bullet list of 3 benefits (use proper list formatting, not unicode bullets).
3. Pricing & Packages — helpers.createTable with columns Package, Price, Includes for 3 tiers: Starter ($99), Home ($199), Pro ($349). Add 1 paragraph on positioning vs competitors.
4. Launch Timeline — helpers.createTable with Milestone, Owner, Target Date for 5 rows (beta, press preview, retail launch, marketing campaign, post-launch review). Add 2 sentences on critical path.
5. Next Steps — numbered list of 6 immediate action items with owners (Product, Marketing, Sales, Support).

Formatting:
- US Letter, professional tone, Arial-style body text
- All tables via helpers.createTable (full width, styled headers)
- Realistic dates in 2025–2026`,
    planSections: [
      {
        name: 'product_overview',
        functionName: 'buildProductOverview',
        sectionHeading: 'Product Overview',
        description: 'Product Overview: two substantial paragraphs on Nova Smart Hub, audience, and value prop.',
      },
      {
        name: 'key_features',
        functionName: 'buildKeyFeatures',
        sectionHeading: 'Key Features',
        description:
          'Four features with Heading 2 each; helpers.createBulletList for benefit bullets under each feature.',
      },
      {
        name: 'pricing_packages',
        functionName: 'buildPricingPackages',
        sectionHeading: 'Pricing & Packages',
        description:
          'Pricing & Packages: helpers.createTable for 3 tiers, one positioning paragraph.',
      },
      {
        name: 'launch_timeline',
        functionName: 'buildLaunchTimeline',
        sectionHeading: 'Launch Timeline',
        description:
          'Launch Timeline: helpers.createTable with 5 milestones, critical-path paragraph.',
      },
      {
        name: 'next_steps',
        functionName: 'buildNextSteps',
        sectionHeading: 'Next Steps',
        description:
          'Next Steps: helpers.createNumberedList with six action items including owners.',
      },
    ],
  },
};

function listScenarios() {
  return Object.values(SCENARIOS).map(s => ({ id: s.id, label: s.label }));
}

function getScenario(id) {
  const key = (id || process.env.DOC_TEST_SCENARIO || 'techcorp').trim().toLowerCase();
  const scenario = SCENARIOS[key];
  if (!scenario) {
    const available = Object.keys(SCENARIOS).join(', ');
    throw new Error(`Unknown DOC_TEST_SCENARIO "${key}". Available: ${available}`);
  }
  return scenario;
}

module.exports = { SCENARIOS, getScenario, listScenarios };
