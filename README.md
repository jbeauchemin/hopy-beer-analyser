# Hopy Beer Analyser

Bot de recherche de données de bières sur veuxtuunebiere.com et Untappd.

## Installation

```bash
npm install
```

## Configuration

1. Copier `.env.example` vers `.env`:
```bash
cp .env.example .env
```

2. Configurer votre `DATABASE_URL` dans `.env`:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/hopy_beer?schema=public"
```

3. Générer le client Prisma:
```bash
npm run db:generate
```

4. Appliquer les migrations (ou push le schema):
```bash
npm run db:migrate
# OU
npm run db:push
```

## Usage

### Analyser une bière manuelle

```bash
# Avec producer et product
node analyze_beers.js --producer="Pit Caribou" --product="IPA de Lesseps"

# Avec product seulement
node analyze_beers.js --product="IPA de Lesseps"

# Format positionnel
node analyze_beers.js "Pit Caribou" "IPA de Lesseps"
```

### Tester l'algorithme avec la base de données

```bash
# Tester 50 bières (par défaut)
node beer_ai.js

# Tester 10 bières
node beer_ai.js --limit=10

# Sortie JSON
node beer_ai.js --json
node beer_ai.js --limit=5 --json
```

## Architecture

### Phase 1: Collecte (Permissive)
- Recherche DuckDuckGo avec plusieurs variantes de requêtes
- Énumération de slugs avec variations (pluriel, sans alcool, etc.)
- Arrêt après 5 candidats pour éviter le rate limiting

### Phase 2: Validation & Scoring (Strict)
- Scoring pondéré: 60% nom produit + 40% nom producteur
- Matching fuzzy pour variations orthographiques
- Seuil minimum: 55%
- Retourne `null` si aucun bon match (préfère pas de données que de mauvaises données)

## Prisma Commands

```bash
# Générer le client Prisma
npm run db:generate

# Créer et appliquer une migration
npm run db:migrate

# Push le schema sans migration
npm run db:push

# Ouvrir Prisma Studio (GUI)
npm run db:studio
```

## Fichiers Principaux

- `analyze_beers.js` - Point d'entrée principal pour analyser une bière
- `beer_ai.js` - Outil de test de l'algorithme avec la base de données
- `scapper/veuxtuunebiere_v2.js` - Scraper pour veuxtuunebiere.com (2-phase architecture)
- `scapper/untapped.js` - Scraper pour Untappd (Algolia API)
- `scapper/duckduckgo.js` - Recherche DuckDuckGo avec Puppeteer
- `prisma/schema.prisma` - Schema de base de données

## Exemple de Résultat

```javascript
{
  input: { producer: "Pit Caribou", product: "IPA de Lesseps" },
  combined: "Pit Caribou IPA de Lesseps",
  vtub: {
    source: "veuxtuunebiere.com",
    url: "https://veuxtuunebiere.com/products/lessep-sans-alcool",
    beer_name: "Lessep sans alcool",
    brewery_name: "Pit Caribou",
    abv: 0.5,
    style: "Sans alcool"
  },
  untappd: {
    bid: 1959394,
    source: "untappd.com",
    url: "https://untappd.com/b/microbrasserie-pit-caribou-session-ipa-de-lesseps/1959394",
    beer_name: "Session IPA de Lesseps",
    brewery_name: "Microbrasserie Pit Caribou",
    type_name: "IPA - Session",
    beer_abv: 4,
    beer_ibu: 15,
    rating_score: 3.83
  }
}
```

## Notes

- Le système fait des délais entre requêtes pour éviter le rate limiting
- Maximum 50 requêtes HTTP par session pour veuxtuunebiere.com
- DuckDuckGo nécessite Chrome/Chromium installé pour Puppeteer
- Le matching fuzzy accepte les variations de pluriel et sous-chaines
