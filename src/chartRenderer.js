let npsChart = null;
let fatigueChart = null;

function destroyChart(chart) {
  if (chart) chart.destroy();
}

export function clearCharts() {
  destroyChart(npsChart);
  destroyChart(fatigueChart);
  npsChart = null;
  fatigueChart = null;
}

export function renderNpsChart(canvas, curves) {
  destroyChart(npsChart);

  npsChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: curves.times,
      datasets: [
        {
          label: "NPS 250ms",
          data: curves.nps250,
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.15
        },
        {
          label: "NPS 500ms",
          data: curves.nps500,
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        mode: "index",
        intersect: false
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8
          },
          title: {
            display: true,
            text: "Time (s)"
          }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "NPS"
          }
        }
      }
    }
  });
}

export function renderFatigueChart(canvas, curves) {
  destroyChart(fatigueChart);

  fatigueChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: curves.times,
      datasets: [
        {
          label: "Fatigue",
          data: curves.fatigue,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15
        },
        {
          label: "Speed",
          data: curves.speed,
          borderWidth: 1,
          pointRadius: 0,
          hidden: true,
          tension: 0.15
        },
        {
          label: "Stamina",
          data: curves.stamina,
          borderWidth: 1,
          pointRadius: 0,
          hidden: true,
          tension: 0.15
        },
        {
          label: "Jack",
          data: curves.jack,
          borderWidth: 1,
          pointRadius: 0,
          hidden: true,
          tension: 0.15
        },
        {
          label: "Chord",
          data: curves.chord,
          borderWidth: 1,
          pointRadius: 0,
          hidden: true,
          tension: 0.15
        },
        {
          label: "Tech",
          data: curves.tech,
          borderWidth: 1,
          pointRadius: 0,
          hidden: true,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        mode: "index",
        intersect: false
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8
          },
          title: {
            display: true,
            text: "Time (s)"
          }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "Strain"
          }
        }
      }
    }
  });
}
