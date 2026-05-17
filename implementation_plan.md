# Unify Library & Recommendations Grid (Revised)

Research shows the "pancaked cards" bug and visual mismatch are caused by inconsistent tab wrapper logic and CSS flexbox conflicts. Recommendations use a `.page-content` wrapper for centering and padding, while Library tries to manage its own layout, leading to a "broken" 6-column squashed grid.

## User Review Required

> [!IMPORTANT]
> To achieve a 1:1 match, the Library's structural hierarchy will be changed to match Recommendations. This involves wrapping the Library in the same `.page-content` container. The "Floating Header" will be adjusted to sit correctly within this unified structure.

## Proposed Changes

### [WORKSPACE] Tab Wrapper Unification

#### [MODIFY] [workspaceTabs.js](file:///e:/Programmin/HTML/Web%20MugelList/js/ui/workspaceTabs.js)
- Remove the special case for `library` in `routeActiveTab()`.
- Ensure all tabs are wrapped in `.page-content` to inherit consistent centering, max-width, and padding.

### [LIBRARY] Layout Refactor

#### [MODIFY] [libraryPage.js](file:///e:/Programmin/HTML/Web%20MugelList/js/pages/libraryPage.js)
- Simplify the outer template to account for the new `.page-content` wrapper.
- Ensure only one `display` mode is active on the view container (removing `flex` if `grid` is desired).

### [CSS] Grid & Container Parity

#### [MODIFY] [layout.css](file:///e:/Programmin/HTML/Web%20MugelList/css/layout.css)
- Synchronize `.library-grid` properties with `.anime-grid`.
- Fix the flex-basis/zero-height issue causing the 30px "pancaking".

#### [MODIFY] [components.css](file:///e:/Programmin/HTML/Web%20MugelList/css/components.css)
- Refine `.library-header-floating` and `.filters-tray` to work seamlessly within the centered `.page-content` area.

## Verification Plan

### Automated Tests
- Browser subagent check:
    - Library and Recommendations center-alignment must match.
    - Card height in both tabs must be ~430px.
    - Sidebar/Tray should not shift the grid alignment differently between tabs.
