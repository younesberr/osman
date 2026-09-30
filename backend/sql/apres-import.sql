-- ============================================================================
-- OSMAN EXPRESS — script à exécuter APRÈS l'import de la base de données.
--
-- Rôle : adapter des données importées (structure delevery_*) à cette version
-- de l'application : suppression du CRM WhatsApp, renommage des clés de
-- configuration propres à l'application (préfixe app_), identité OSMAN EXPRESS.
-- Idempotent : peut être relancé sans effet de bord.
--
-- Usage : mysql -u <utilisateur> -p osmanexpress < backend/sql/apres-import.sql
--
-- ATTENTION : ce script ne nettoie PAS les données métier (clients, colis,
-- tarifs, utilisateurs, factures…). Si l'export importé provient d'une autre
-- société, ces données sont à purger séparément avant toute livraison.
-- ============================================================================
SET NAMES utf8mb4;

-- 1. CRM WhatsApp (Meta Cloud API) : fonctionnalité retirée de l'application.
DROP TABLE IF EXISTS
  delevery_whatsapp_conversation,
  delevery_whatsapp_message,
  delevery_whatsapp_modele,
  delevery_whatsapp_regle,
  delevery_whatsapp_reponse_rapide,
  delevery_whatsapp_pref_client;

DELETE FROM delevery_configs
 WHERE configs_var LIKE 'ortalog\_whatsapp\_%' OR configs_var LIKE 'app\_whatsapp\_%';

-- Codes de menu du CRM retirés des droits utilisateurs (liste séparée par des virgules).
UPDATE delevery_users
   SET users_services = TRIM(BOTH ',' FROM
         REPLACE(
           REPLACE(
             REPLACE(CONCAT(',', REPLACE(users_services, ' ', ''), ','), ',API_LIAISON,', ','),
             ',WHATSAPP_DISCUSSIONS,', ','),
           ',,', ','))
 WHERE users_services LIKE '%API_LIAISON%' OR users_services LIKE '%WHATSAPP_DISCUSSIONS%';

-- 2. Clés de configuration propres à l'application : préfixe historique → app_.
UPDATE delevery_configs
   SET configs_var = CONCAT('app_', SUBSTRING(configs_var, 9))
 WHERE configs_var LIKE 'ortalog\_%';

-- 3. Fichiers de l'ancienne société qui n'existent plus dans backend/uploads.
DELETE FROM delevery_configs
 WHERE configs_var IN ('app_scan_son', 'app_company_entete',
                       'app_contrat_particulier_fr', 'app_contrat_particulier_ar',
                       'app_contrat_societe_fr', 'app_contrat_societe_ar');

-- 4. Identité OSMAN EXPRESS (Admin > Configuration > Plateforme).
DELETE FROM delevery_configs
 WHERE configs_var IN ('app_company_name', 'app_company_email', 'app_company_website',
                       'app_platform_logo', 'app_platform_favicon',
                       'app_platform_color_primary', 'app_platform_color_secondary',
                       'app_message_livreur');
INSERT INTO delevery_configs (configs_var, configs_val) VALUES
  ('app_company_name', 'OSMAN EXPRESS'),
  ('app_company_email', 'contact@osmanexpress.ma'),
  ('app_company_website', 'https://osmanexpress.ma'),
  ('app_platform_logo', 'logo-osmanexpress.png'),
  ('app_platform_favicon', 'icon-osmanexpress.png'),
  ('app_platform_color_primary', '#d80613'),
  ('app_platform_color_secondary', '#111111'),
  ('app_message_livreur', 'Bonjour {destinataire}, je suis le livreur OSMAN EXPRESS. J’ai un colis pour vous : {code} ({magasin}), montant à régler : {crbt}. Adresse : {adresse}, {ville}. Merci de me confirmer votre disponibilité.');

-- Coordonnées légales de l'ancienne société effacées (à saisir dans Plateforme).
UPDATE delevery_configs
   SET configs_val = ''
 WHERE configs_var IN ('app_company_forme_juridique', 'app_company_siege',
                       'app_company_tel_fixe', 'app_company_tel_mobile',
                       'app_company_ice', 'app_company_rc', 'app_company_if', 'app_company_cnss');

-- Clés héritées de l'ancien système PHP : valeurs de l'ancienne société neutralisées.
UPDATE delevery_configs
   SET configs_val = ''
 WHERE configs_var IN ('config_company_logo', 'config_company_favicon', 'config_company_website',
                       'config_ws_video_youtube', 'config_ws_link_admin', 'config_ws_link_direct',
                       'config_ws_link_shipper', 'ws_config_author');

-- 5. Libellés (delevery_string) : nom, e-mail et textes marketing de l'ancienne société.
UPDATE delevery_string SET string_text = 'OSMAN EXPRESS'
 WHERE string_ref = 'lang_db_ws_config_company_name';
UPDATE delevery_string SET string_text = 'contact@osmanexpress.ma'
 WHERE string_ref = 'lang_db_ws_config_company_email';
UPDATE delevery_string SET string_text = ''
 WHERE string_ref IN ('lang_db_ws_config_company_phone', 'lang_db_ws_config_company_phone2',
                      'lang_db_ws_config_company_fix', 'lang_db_ws_config_company_address');
DELETE FROM delevery_string WHERE string_ref LIKE 'lang_db_ws_config_a_propos%';
UPDATE delevery_string
   SET string_text = REPLACE(string_text, 'ORTALOG', 'OSMAN EXPRESS')
 WHERE string_text LIKE '%ORTALOG%';
UPDATE delevery_string
   SET string_text = REPLACE(REPLACE(string_text, 'أورطالوج', 'أوسمان إكسبريس'), 'أورتالوج', 'أوسمان إكسبريس')
 WHERE string_text LIKE '%أورطالوج%' OR string_text LIKE '%أورتالوج%';

-- 6. Autres textes susceptibles de porter l'ancien nom.
UPDATE delevery_parcel_statut
   SET parcel_statut_sms_text = REPLACE(parcel_statut_sms_text, 'ORTALOG', 'OSMAN EXPRESS')
 WHERE parcel_statut_sms_text LIKE '%ORTALOG%';
UPDATE delevery_agences
   SET agence_code = CONCAT('OSM', SUBSTRING(agence_code, 5))
 WHERE agence_code LIKE 'Orta%';

-- Contrôle : ces deux requêtes doivent renvoyer 0 ligne.
-- SELECT configs_var FROM delevery_configs WHERE configs_var LIKE 'ortalog%';
-- SHOW TABLES LIKE 'delevery_whatsapp%';
