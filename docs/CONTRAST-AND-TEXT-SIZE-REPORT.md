# Contrast and small-text report (approved dashboard)

**Status: report only. No style has been changed** (as requested). This lists what a later, approved design pass could fix.

Measured with a real browser (Microsoft Edge) on the approved `interface/` build at 1440 px wide, across four screen states: Overview, workspace menu open, toast after an approval, and a module placeholder page. Contrast follows WCAG 2.2 AA: **4.5 : 1** for normal text, **3 : 1** for large text (24 px, or 18.7 px bold).

## Summary

- Text pieces measured: **405** (60 distinct style combinations)
- Below the AA contrast requirement: **176 pieces in 23 style combinations**
- Text smaller than 12 px: **241 pieces in 33 style combinations** (WCAG sets no minimum size, but 9-11 px is hard to read, especially on phones)
- Computed by hand because the text sits on a gradient: 2 combinations (section 3)

## 1. Text that fails the contrast requirement

Worst first. "Suggested" is the closest same-hue colour that would pass, so the look stays as close as possible to the approved design. Nothing has been applied.

| # | Where (CSS path) | Example text | Size | Text colour | Background | Ratio | Needs | Suggested fix | Seen on |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `div.client-row > div.client-name > b.client-avatar.u` | "U" | 10px bold | `#ffffff` | `#1db6ad` | **2.52** | 4.5 | background `#15857e` | all screens |
| 2 | `section.card > div.legend > span` | "● ROAS" | 10px | `#0bb2ae` | `#ffffff` | **2.63** | 4.5 | text `#088481` | all screens |
| 3 | `div.chart > div.x-axis > span` | "Apr 1", "Apr 7" | 9px | `#94a0b2` | `#ffffff` | **2.65** | 4.5 | text `#6d7684` | all screens |
| 4 | `section.card > div.client-row > div.score` | "92", "78" | 11px | `#1aaf75` | `#ffffff` | **2.83** | 4.5 | text `#14875a` | all screens |
| 5 | `section.card > div.approval > button.approve` | "Approve" | 10px bold | `#ffffff` | `#0eaf6d` | **2.85** | 4.5 | background `#0b8754` | all screens |
| 6 | `div.title > div.roas > span` | "Leads MoM", "Avg ROAS" | 10px | `#8b96a9` | `#ffffff` | **2.99** | 4.5 | text `#6d7685` | all screens |
| 7 | `div.approval > div > small` | "Nova Clinic", "•" | 9px | `#8a96a9` | `#ffffff` | **2.99** | 4.5 | text `#6c7685` | all screens |
| 8 | `div.stat > div > em` | "↗", "+14%" | 11px bold | `#13a861` | `#ffffff` | **3.09** | 4.5 | text `#0f884f` | all screens |
| 9 | `div.title > div.roas > strong` | "↗ +42%" | 17px bold | `#13a56e` | `#ffffff` | **3.17** | 4.5 | text `#0f8659` | all screens |
| 10 | `div.timeline-item > div > p` | "Nova Clinic • 2 minutes ago", "Bright Homes • 12 minutes ago" | 11px | `#8591a7` | `#ffffff` | **3.18** | 4.5 | text `#6d7789` | all screens |
| 11 | `div.client-name > div > small` | "Healthcare", "Real Estate" | 9px | `#8591a4` | `#ffffff` | **3.19** | 4.5 | text `#6d7787` | all screens |
| 12 | `div.actions > button.bell > i` | "3" | 10px | `#ffffff` | `#ff4e5b` | **3.23** | 4.5 | background `#d2404b` | all screens |
| 13 | `section.card > div.approval > span.done` | "Approved" | 10px bold | `#15a36b` | `#ffffff` | **3.24** | 4.5 | text `#118658` | Toast + approved item |
| 14 | `div.healthy > div > p` | "Your AI operations are running smoothly." | 11px | `#289771` | `#e6fbf0` | **3.37** | 4.5 | text `#217e5e` | all screens |
| 15 | `section.card > div.approval > button.review` | "Review" | 10px bold | `#a97816` | `#fff0c8` | **3.44** | 4.5 | text `#8f6613` | all screens |
| 16 | `div > em > small` | "vs last month" | 10px | `#7d8aa2` | `#ffffff` | **3.48** | 4.5 | text `#6b778b` | all screens |
| 17 | `section.card > div.client-row > span.pill.limited` | "Limited" | 9px | `#ae7200` | `#fff2d4` | **3.63** | 4.5 | text `#986400` | all screens |
| 18 | `div.client-row > div.channels > span.channel.yt` | "yt" | 9px bold | `#ffffff` | `#ee3838` | **3.99** | 4.5 | background `#dd3434` | all screens |
| 19 | `section.card > div.title > span.checked` | "Last checked: Apr 24, 2025, 9:12 AM" | 11px | `#71809a` | `#ffffff` | **4.00** | 4.5 | text `#69778f` | all screens |
| 20 | `section.card > div.table-head > span` | "Client", "Channels" | 10px | `#687893` | `#f1f4fa` | **4.06** | 4.5 | text `#606f88` | all screens |
| 21 | `div.healthy > div > strong` | "All systems healthy" | 16px bold | `#088657` | `#e6fbf0` | **4.26** | 4.5 | text `#088053` | all screens |
| 22 | `div.module > div > p` | "This module is ready for the next implem" | 16px | `#687891` | `#ffffff` | **4.48** | 4.5 | text `#66768f` | Module placeholder page |
| 23 | `div.client-row > div.channels > span.channel.f` | "f" | 9px bold | `#ffffff` | `#3d71e3` | **4.50** | 4.5 | background `#3c6fe0` | all screens |

## 2. Text smaller than 12 px

| Size | Where (CSS path) | Example text | Pieces |
|---|---|---|---|
| 9px | `div.approval > div > small` | "Nova Clinic", "•" | 27 |
| 9px | `div.chart > div.x-axis > span` | "Apr 1", "Apr 7" | 15 |
| 9px | `div.client-name > div > small` | "Healthcare", "Real Estate" | 9 |
| 9px | `div.client-row > div.channels > span.channel.ig` | "ig" | 9 |
| 9px | `div.client-row > div.channels > span.channel.f` | "f" | 6 |
| 9px | `div.client-row > div.channels > span.channel.in` | "in" | 6 |
| 9px | `div.client-row > div.channels > span.channel.yt` | "yt" | 6 |
| 9px | `section.card > div.client-row > span.pill.full` | "Full Access" | 6 |
| 9px | `div.client-row > div.channels > span.channel.tk` | "tk" | 6 |
| 9px | `section.card > div.client-row > span.pill.limited` | "Limited" | 3 |
| 10px | `section.card > div.table-head > span` | "Client", "Channels" | 18 |
| 10px | `div > em > small` | "vs last month" | 12 |
| 10px | `div.client-name > div > strong` | "Nova Clinic", "Bright Homes" | 9 |
| 10px | `div.title > div.roas > span` | "Leads MoM", "Avg ROAS" | 6 |
| 10px | `section.card > div.client-row > div.status.active` | "Active" | 6 |
| 10px | `section.card > div.client-row > div.status.healthy` | "Healthy" | 6 |
| 10px | `section.card > div.approval > button.approve` | "Approve" | 5 |
| 10px | `div.actions > button.bell > i` | "3" | 4 |
| 10px | `section.card > div.legend > span` | "● Leads" | 3 |
| 10px | `section.card > div.legend > span` | "● ROAS" | 3 |
| 10px | `div.client-row > div.client-name > b.client-avatar.n` | "N" | 3 |
| 10px | `div.client-row > div.client-name > b.client-avatar.b` | "B" | 3 |
| 10px | `section.card > div.client-row > div.status.paused` | "Paused" | 3 |
| 10px | `section.card > div.client-row > div.status.attention` | "Needs Attention" | 3 |
| 10px | `div.client-row > div.client-name > b.client-avatar.u` | "U" | 3 |
| 10px | `section.card > div.approval > button.review` | "Review" | 3 |
| 10px | `section.card > div.approval > span.done` | "Approved" | 1 |
| 11px | `div.stat > div > em` | "↗", "+14%" | 24 |
| 11px | `div.timeline-item > div > p` | "Nova Clinic • 2 minutes ago", "Bright Homes • 12 minutes ago" | 9 |
| 11px | `section.card > div.client-row > div.score` | "92", "78" | 9 |
| 11px | `div.approval > div > strong` | "Meta campaign budget change", "LinkedIn post" | 9 |
| 11px | `section.card > div.title > span.checked` | "Last checked: Apr 24, 2025, 9:12 AM" | 3 |
| 11px | `div.healthy > div > p` | "Your AI operations are running smoothly." | 3 |

## 3. Text over gradients

Automatic measuring cannot read a gradient, so these were computed from the gradient end colours in the stylesheet:

- **Active menu item** (white 16 px text on the violet highlight `#5840e8` to `#4a42e8`): **6.34 : 1** and **6.49 : 1** - passes.
- **Instagram chip** (white 9 px bold text on the gradient `#f2a235` to `#bf2d89`): **2.10 : 1** at the orange end and **5.31 : 1** at the magenta end - the orange end fails.

## 4. Non-text contrast (icons and chart)

WCAG 1.4.11 asks 3 : 1 for meaningful graphics. From the stylesheet colours: the teal ROAS line `#09b8b2` on white is **2.47 : 1**, and the green status dots `#16b96d` are **2.56 : 1**. The chart has a text alternative, so this is a visual-clarity issue rather than a blocker.

## How to decide

- **Smallest change with the biggest effect:** darken the ~10 worst text colours to the suggested shades. The look stays the same to most eyes, and no layout changes.
- **Bigger change:** raise the 9-11 px text to 12 px. This makes the tables and approval rows slightly larger.
- Tell me which (or neither) and I will do it in a separate, reviewable step with before/after screenshots.
