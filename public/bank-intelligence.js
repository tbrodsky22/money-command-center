(function () {
  const token = () => localStorage.getItem('mcc_token') || '';

  function formatMoney(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(Number(value || 0));
  }

  function classify(transaction) {
    const text = `${transaction.category || ''} ${transaction.merchant_name || ''} ${transaction.name || ''}`.toLowerCase();
    if (text.includes('transfer') || text.includes('credit card payment') || text.includes('ach payment')) return 'Transfer';
    if (text.includes('payroll') || text.includes('direct deposit') || text.includes('salary')) return 'Income';
    if (text.includes('grocery') || text.includes('supermarket')) return 'Groceries';
    if (text.includes('restaurant') || text.includes('dining') || text.includes('coffee') || text.includes('doordash')) return 'Food & Dining';
    if (text.includes('gas') || text.includes('fuel') || text.includes('uber') || text.includes('lyft')) return 'Transportation';
    if (text.includes('amazon') || text.includes('walmart') || text.includes('target') || text.includes('shopping')) return 'Shopping';
    if (text.includes('mortgage') || text.includes('rent')) return 'Housing';
    if (text.includes('electric') || text.includes('utility') || text.includes('internet') || text.includes('wireless')) return 'Utilities';
    if (text.includes('netflix') || text.includes('spotify') || text.includes('hulu') || text.includes('movie')) return 'Entertainment';
    if (text.includes('pharmacy') || text.includes('medical') || text.includes('doctor')) return 'Health';
    if (text.includes('airline') || text.includes('hotel') || text.includes('airbnb')) return 'Travel';
    return transaction.category || 'Other';
  }

  function isTransfer(transaction) {
    return Boolean(transaction.excluded) || classify(transaction) === 'Transfer';
  }

  function isSpend(transaction) {
    return !transaction.pending && !isTransfer(transaction) && Number(transaction.amount) > 0;
  }

  function isIncome(transaction) {
    return !transaction.pending && !transaction.excluded && Number(transaction.amount) < 0 && classify(transaction) === 'Income';
  }

  function transactionDate(value) {
    return new Date(String(value).slice(0, 10) + 'T12:00:00');
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function recurringPatterns(transactions) {
    const groups = new Map();
    for (const transaction of transactions.filter(isSpend)) {
      const key = String(transaction.merchant_name || transaction.name || '').toLowerCase().trim();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(transaction);
    }

    const patterns = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      rows.sort((a, b) => transactionDate(a.posted_date) - transactionDate(b.posted_date));
      const amounts = rows.map(row => Number(row.amount));
      const average = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
      const stableAmounts = amounts.every(amount => Math.abs(amount - average) / Math.max(average, 1) < 0.35);
      if (!stableAmounts) continue;

      const gaps = [];
      for (let index = 1; index < rows.length; index += 1) {
        gaps.push(Math.round((transactionDate(rows[index].posted_date) - transactionDate(rows[index - 1].posted_date)) / 86400000));
      }
      gaps.sort((a, b) => a - b);
      const gap = gaps[Math.floor(gaps.length / 2)];
      let cadence = '';
      if (gap >= 25 && gap <= 38) cadence = 'monthly';
      else if (gap >= 12 && gap <= 18) cadence = 'biweekly';
      else if (gap >= 5 && gap <= 9) cadence = 'weekly';
      if (!cadence) continue;

      const last = rows[rows.length - 1];
      const next = new Date(transactionDate(last.posted_date));
      next.setDate(next.getDate() + gap);
      patterns.push({
        name: last.merchant_name || last.name,
        amount: average,
        cadence,
        next,
        confidence: rows.length >= 3 ? 'high' : 'medium'
      });
    }
    return patterns;
  }

  function calculate(data, dashboard) {
    const transactions = data.transactions || [];
    const now = new Date();
    const currentMonth = monthKey(now);
    const previousMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    let spent = 0;
    let previousSpent = 0;
    let income = 0;
    const categories = {};

    for (const transaction of transactions) {
      const key = monthKey(transactionDate(transaction.posted_date));
      if (key === currentMonth && isSpend(transaction)) {
        spent += Number(transaction.amount);
        const category = classify(transaction);
        categories[category] = (categories[category] || 0) + Number(transaction.amount);
      }
      if (key === previousMonth && isSpend(transaction)) previousSpent += Number(transaction.amount);
      if (key === currentMonth && isIncome(transaction)) income += Math.abs(Number(transaction.amount));
    }

    const recurring = recurringPatterns(transactions);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const upcoming = recurring.filter(item => item.next >= now && item.next <= monthEnd);
    const upcomingBills = upcoming.reduce((sum, item) => sum + item.amount, 0);

    const liquid = (data.accounts || [])
      .filter(account => /checking|savings|depository|cash management|money market/i.test(`${account.account_type || ''} ${account.account_subtype || ''}`))
      .reduce((sum, account) => sum + Number(account.available_balance ?? account.current_balance ?? 0), 0);

    const plannedSavings = (dashboard.budget || [])
      .filter(row => /saving|goal/i.test(row.name || ''))
      .reduce((sum, row) => sum + Number(row.planned || 0), 0);

    const takeHome = Number(dashboard.profile?.monthly_take_home || 0);
    const safetyBuffer = Math.max(250, Math.min(Math.max(liquid, 0) * 0.15, takeHome * 0.1 || 500));
    const safeToSpend = Math.max(0, liquid - upcomingBills - plannedSavings - safetyBuffer);

    return {
      spent,
      previousSpent,
      income,
      categories,
      recurring,
      upcoming,
      upcomingBills,
      liquid,
      plannedSavings,
      safetyBuffer,
      safeToSpend,
      change: previousSpent ? ((spent - previousSpent) / previousSpent) * 100 : null
    };
  }

  async function refresh() {
    if (!token()) return;
    try {
      const headers = { Authorization: 'Bearer ' + token() };
      const [financialResponse, dashboardResponse] = await Promise.all([
        fetch('/api/financial-data', { headers }),
        fetch('/api/dashboard', { headers })
      ]);
      if (!financialResponse.ok || !dashboardResponse.ok) return;
      const financial = await financialResponse.json();
      const dashboard = await dashboardResponse.json();
      if (!financial.summary?.connected) return;

      const intelligence = calculate(financial, dashboard);
      window.__mccSmartBank = { financial, intelligence, classify };

      const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
      };

      setText('biSpend', formatMoney(intelligence.spent));
      setText('biIncome', formatMoney(intelligence.income));
      setText('biRecurring', formatMoney(intelligence.upcomingBills));
      setText('biSafe', formatMoney(intelligence.safeToSpend));
      setText('biHomeSpend', formatMoney(intelligence.spent));
      setText('biHomeIncome', formatMoney(intelligence.income));
      setText('biHomeRecurring', formatMoney(intelligence.upcomingBills));
      setText('biHomeSafe', formatMoney(intelligence.safeToSpend));
      setText('safe', formatMoney(intelligence.safeToSpend));
      setText('budgetSafe', formatMoney(intelligence.safeToSpend));

      const categoryList = document.getElementById('biCats');
      if (categoryList) {
        categoryList.innerHTML = Object.entries(intelligence.categories)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, value]) => `<div class="item split"><span>${name}</span><strong>${formatMoney(value)}</strong></div>`)
          .join('') || '<div class="empty">No spending yet.</div>';
      }

      const watch = document.getElementById('biWatch');
      if (watch) {
        watch.innerHTML = intelligence.upcoming
          .slice(0, 6)
          .map(item => `<div class="item"><strong>${item.name}</strong><span class="muted small">Likely ${formatMoney(item.amount)} ${item.cadence} · ${item.confidence} confidence · next around ${item.next.toLocaleDateString()}</span></div>`)
          .join('') || '<div class="empty">No recurring patterns yet.</div>';
      }
    } catch (error) {
      console.warn('Bank intelligence refresh failed', error);
    }
  }

  function boot() {
    if (token() && !document.getElementById('app')?.classList.contains('hidden')) refresh();
  }

  document.addEventListener('DOMContentLoaded', boot);
  new MutationObserver(boot).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  window.mccRefreshSmartMoney = refresh;
})();